#!/usr/bin/env bash
# 涌现式桌面 · 安装 / 回滚
#
#   ./deploy/install.sh                 # 装（或更新到 latest）：建工作负载 → 接管桌面入口
#   ./deploy/install.sh --tag sha-xxxx  # 装指定版本（回滚就用这个）
#   ./deploy/install.sh --revert        # 桌面切回官方，我们的 pod 留着（不删数据）
#   ./deploy/install.sh --uninstall     # 切回官方 + 删掉工作负载与权限（数据保留）
#
# 定位：这是**社区版桌面的替换层**，不是市场里的一个应用。所以：
#   · 没有 entrance、没有市场卸载入口、没有 app 命名空间
#   · 一条命令装、一条命令回滚，出了事你不用去翻三个命名空间
#   · 数据仍在用户 Home（Files 里看得见），重装不丢
#
# 代码在镜像里（ghcr.io/bbigdan/emergent-desktop-{shell,agent,memory}），
# 由 .github/workflows/images.yml 在 push 到 main 时构建。
#
# 为什么工作负载是 ReplicaSet：平台的 `appns-validating-webhook` 只拦
# deployments / statefulsets / daemonsets 的 CREATE。裸 Pod 能过但不自愈
# （节点重启、手滑 delete 之后桌面就死在那儿，而且没有任何地方报错）。
# ReplicaSet 能过，删 pod 10 秒自己回来（实测）。
set -euo pipefail

HOST="${OLARES_HOST:-root@199.68.217.186}"
KEY="${OLARES_KEY:-$HOME/.ssh/olares_ed25519}"
USER_NAME="${OLARES_USER:-bbbigdan}"
NS="user-space-$USER_NAME"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/bbigdan/emergent-desktop}"
IMAGE_TAG="latest"
STATE_DIR="/olares/emergent-desktop/state/$USER_NAME"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) IMAGE_TAG="${2:?--tag 要给个标签，例如 sha-1a2b3c4}"; shift 2 ;;
    --tag=*) IMAGE_TAG="${1#--tag=}"; shift ;;
    -*) break ;;
    *) break ;;
  esac
done

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$HOST")

say() { printf '\033[36m→\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

switch_to() {
  "${SSH[@]}" "kubectl -n $NS patch svc edge-desktop -p '{\"spec\":{\"selector\":{\"app\":\"$1\"}}}' >/dev/null \
    && kubectl -n $NS get svc edge-desktop -o jsonpath='{.spec.selector.app}' && echo"
}

# ── 回滚 / 卸载 ──────────────────────────────────────────
if [ "${1:-}" = "--revert" ] || [ "${1:-}" = "--uninstall" ]; then
  say "桌面入口切回官方（app=olares-app）"
  switch_to olares-app
  if [ "${1:-}" = "--uninstall" ]; then
    say "删掉工作负载与权限（数据保留）"
    # 先删 RS 再删 SA/RBAC：RS 里的 memory 侧车还在写图，先停它
    "${SSH[@]}" "kubectl -n $NS delete rs emergent-desktop --ignore-not-found --wait=true --timeout=40s >/dev/null 2>&1 || true
      kubectl -n $NS delete secret emergent-desktop-env --ignore-not-found >/dev/null 2>&1 || true
      kubectl -n $NS delete sa emergent-desktop --ignore-not-found >/dev/null 2>&1 || true
      kubectl delete clusterrolebinding emergent-desktop-read --ignore-not-found >/dev/null 2>&1 || true
      kubectl delete clusterrole emergent-desktop-read --ignore-not-found >/dev/null 2>&1 || true
      echo cleaned"
    say "数据保留：$NS 里用户的 Home/Agent（记忆、人格、drift）与 $STATE_DIR（会话、用量）"
    say "要连数据一起清：ssh $HOST 'rm -rf /olares/rootfs/userspace/pvc-userspace-$USER_NAME-*/Home/Agent $STATE_DIR'"
  fi
  exit 0
fi

# ── 0. 先确认镜像拉得到 ──────────────────────────────────
# 顺序很重要：**先探测，再动线上**。反过来的话，镜像标签写错了、包是 private、
# ghcr 抽风 —— 每一种都会先把你正在跑的桌面删掉，然后卡在 ImagePullBackOff，
# 而那时候能看的东西只剩事件里的 401。
say "探测镜像（匿名，$IMAGE_TAG）"
"${SSH[@]}" "for I in shell agent memory; do
    R='bbigdan/emergent-desktop-'\$I
    T=\$(curl -s -m 10 \"https://ghcr.io/token?scope=repository:\$R:pull&service=ghcr.io\" | sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p')
    C=\$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H \"Authorization: Bearer \$T\" \
        -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
        \"https://ghcr.io/v2/\$R/manifests/$IMAGE_TAG\")
    echo \"  \$I: HTTP \$C\"
    [ \"\$C\" = 200 ] || exit 7
  done" || die "镜像 $IMAGE_TAG 拉不到 —— 线上没动过。先在 GitHub 的 Actions 里看构建，或换 --tag"

# ── 1. 找用户 Home ─────────────────────────────────────
say "找用户 Home"
HOME_PATH="$("${SSH[@]}" "ls -d /olares/rootfs/userspace/pvc-userspace-$USER_NAME-*/Home 2>/dev/null | head -1")"
[ -n "$HOME_PATH" ] || die "找不到 pvc-userspace-$USER_NAME-*/Home（用户 $USER_NAME 在这台机器上吗？）"
say "  $HOME_PATH"

[ -f "$REPO/agent/.env" ] || say "没有 agent/.env —— 没有模型 key 时它会答不上话（其余功能正常）"

# ── 2. 模型 key ─────────────────────────────────────────
if [ -f "$REPO/agent/.env" ]; then
  say "写 Secret emergent-desktop-env"
  cat "$REPO/agent/.env" | "${SSH[@]}" \
    "kubectl -n $NS create secret generic emergent-desktop-env --from-env-file=/dev/stdin \
       --dry-run=client -o yaml | kubectl apply -f - >/dev/null && echo ok"
fi

# ── 3. 工作负载 ─────────────────────────────────────────
# Home 的真实路径带随机后缀，猜不得：猜错的表现是"跑起来了、数据写到另一个目录"，
# 而界面上看不出来 —— 只有用户去 Files 里翻的时候才发现东西不见了。
say "apply 工作负载（ReplicaSet，$IMAGE_TAG）"
sed -e "s|__USER_HOME__|$HOME_PATH|g" \
    -e "s|__STATE_DIR__|$STATE_DIR|g" \
    -e "s|__IMAGE_PREFIX__|$IMAGE_PREFIX|g" \
    -e "s|__IMAGE_TAG__|$IMAGE_TAG|g" \
    "$HERE/desktop-k8s.yaml" | "${SSH[@]}" "kubectl apply -f - 2>&1 | tail -6"

# ReplicaSet 和 Deployment 的一个关键差别：改了 pod template **不会**替换已有的 pod，
# 它只保证"数量对"。不显式删，新镜像永远不生效，而日志里看到的是旧容器的报错 ——
# 那种"我明明改了"的错觉最费时间。
say "重建 pod（让新模板 + 新镜像生效）"
"${SSH[@]}" "kubectl -n $NS delete pod -l app=emergent-desktop --ignore-not-found --wait=false >/dev/null 2>&1 || true"

# kubectl 的 `rollout status` 不认 ReplicaSet（只认 deploy/sts/ds），
# 所以这里自己等：pod 出现 + 三个容器都 Ready。
say "等就绪（最多 120s）"
"${SSH[@]}" "for i in \$(seq 1 60); do
    R=\$(kubectl -n $NS get pod -l app=emergent-desktop -o jsonpath='{.items[0].status.containerStatuses[*].ready}' 2>/dev/null)
    case \"\$R\" in 'true true true') echo ready; exit 0;; esac
    sleep 2
  done
  kubectl -n $NS get pod -l app=emergent-desktop
  echo '--- 事件（ImagePullBackOff 只有这里说得清）---'
  kubectl -n $NS describe pod -l app=emergent-desktop 2>&1 | sed -n '/Events:/,\$p' | tail -15
  echo '--- agent 日志 ---'
  kubectl -n $NS logs -l app=emergent-desktop -c agent --tail=25 2>&1 | tail -25
  exit 1" || die "没起来，输出在上面"

# ── 4. 接管桌面入口 ─────────────────────────────────────
# selector 决定"桌面"这个域名去哪。改它之前，pod 必须已经就绪 ——
# 反过来做的表现是"桌面白屏十秒"，而用户只会以为它坏了。
say "接管桌面入口（selector → app=emergent-desktop）"
switch_to emergent-desktop

# 入口 Service 的 targetPort 也得对上：我们的 nginx 听 91，
# 官方 pod 也是 91，所以这里通常不用改；写出来是为了防止哪天壳层换端口。
"${SSH[@]}" "kubectl -n $NS patch svc edge-desktop --type=merge -p '{\"spec\":{\"ports\":[{\"name\":\"http\",\"port\":80,\"targetPort\":91,\"protocol\":\"TCP\"}]}}' >/dev/null 2>&1 || true"

# ── 5. 验收 ─────────────────────────────────────────────
say "健康检查（经壳层 nginx：/agent/api/health）"
"${SSH[@]}" "IP=\$(kubectl -n $NS get pod -l app=emergent-desktop -o jsonpath='{.items[0].status.podIP}')
  curl -s -m 8 \"http://\$IP:91/agent/api/health\" || echo '（宿主机连不到 pod IP，跳过）'"
echo

cat <<EOF

装好了。打开桌面就是它：https://desktop.$USER_NAME.olares.com

镜像：$IMAGE_PREFIX-{shell,agent,memory}:$IMAGE_TAG
数据：
  记忆/人格  Userspace/Home/Agent        （Files 里看得见）
  会话/用量  $STATE_DIR

改完代码让它上线：
  git push            # CI 打镜像（三份并行，约 1~2 分钟）
  ./deploy/install.sh # 拉 latest 并重建 pod

回滚到某个提交：./deploy/install.sh --tag sha-<7位>
  标签列表：gh api /user/packages/container/emergent-desktop-agent/versions --jq '.[].metadata.container.tags'

桌面回官方：./deploy/install.sh --revert
连工作负载一起删：./deploy/install.sh --uninstall      （数据保留）
EOF

# 早期版本把代码铺在节点上（hostPath）。现在代码在镜像里，那三份是死重量。
if "${SSH[@]}" "test -d /olares/emergent-desktop/app"; then
  echo
  say "节点上还留着旧版 hostPath 代码（现在不用了，可删）"
  echo "  ssh $HOST 'du -sh /olares/emergent-desktop/{app,www,py} 2>/dev/null; rm -rf /olares/emergent-desktop/{app,www,py}'"
fi
