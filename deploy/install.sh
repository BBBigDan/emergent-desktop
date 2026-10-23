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
# 代码在镜像里（docker.io/<hub用户>/emergent-desktop-{shell,agent,memory}），
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
# 镜像前缀（不含 -shell/-agent/-memory）。默认 Docker Hub 上 bbigdan 的 public 仓库，
# 集群匿名拉得到，不需要 imagePullSecret。换仓库时只改这一个环境变量。
IMAGE_PREFIX="${IMAGE_PREFIX:-docker.io/bbigdan/emergent-desktop}"
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
# 仓库设成了 private —— 每一种都会先把你正在跑的桌面删掉，然后卡在 ImagePullBackOff，
# 而那时候能看的东西只剩事件里的 401。
say "探测镜像（匿名，$IMAGE_TAG）"
# 两个 registry 的匿名取 manifest 流程不一样，按前缀分派：
#   docker.io —— 先向 auth.docker.io 换 token，再打 registry-1.docker.io
#   其它       —— 同一个主机上的 /token 端点（ghcr 就是这样）
# 探测脚本用 heredoc 发到远端跑：本地不展开任何 $，省掉三层反斜杠。
REG="${IMAGE_PREFIX%%/*}"
# 注意别叫 REPO：上面的 REPO 是仓库根目录，被覆盖一次就会让
# `[ -f "$REPO/agent/.env" ]` 永远为假 —— 表现是"部署成功，但 Secret 从没更新"，
# 而输出里那句"没有 agent/.env"看起来像是你自己没建文件。（踩过）
REG_REPO="${IMAGE_PREFIX#*/}"
PROBE=$(sed -e "s|@REG@|$REG|g" -e "s|@REPO@|$REG_REPO|g" -e "s|@TAG@|$IMAGE_TAG|g" <<'EOS'
for I in shell agent memory; do
  R="@REPO@-$I"
  if [ "@REG@" = "docker.io" ]; then
    U="https://auth.docker.io/token?service=registry.docker.io&scope=repository:$R:pull"
    M="https://registry-1.docker.io/v2/$R/manifests/@TAG@"
  else
    U="https://@REG@/token?scope=repository:$R:pull&service=@REG@"
    M="https://@REG@/v2/$R/manifests/@TAG@"
  fi
  T=$(curl -s -m 10 "$U" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  # 顺带把 digest 取回来：**标签是可变的**。实测两次了 —— `latest` 在 CDN 边缘
  # 偶尔还指向上一版 manifest，agent 起来就崩（TypeError），重拉一次又好了。
  # 按 digest 部署就没有这个窗口，而且日志里能看见到底跑的是哪一份。
  H=$(curl -s -D - -o /dev/null -m 20 -H "Authorization: Bearer $T" \
      -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
      "$M" | tr -d '\r')
  C=$(printf '%s\n' "$H" | sed -n '1s/.* \([0-9]\{3\}\).*/\1/p')
  D=$(printf '%s\n' "$H" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -1)
  echo "  $I: HTTP $C $D"
  [ "$C" = 200 ] || exit 7
done
EOS
)
PROBE_OUT=$("${SSH[@]}" sh -s <<<"$PROBE") || die "镜像 $IMAGE_TAG 拉不到 —— 线上没动过。先在 Actions 里看构建，或换 --tag"
echo "$PROBE_OUT"
# 取每行的 digest（没取到就退回标签，不影响部署，只是少了那层保险）
dig() { echo "$PROBE_OUT" | sed -n "s/^ *$1: HTTP [0-9]* \(sha256:[0-9a-f]\{64\}\)$/\1/p" | head -1; }
D_SHELL=$(dig shell); D_AGENT=$(dig agent); D_MEMORY=$(dig memory)
pin() { if [ -n "$2" ]; then printf '%s@%s' "$1" "$2"; else printf '%s' "$1"; fi; }
IMG_SHELL=$(pin "$IMAGE_PREFIX-shell:$IMAGE_TAG" "$D_SHELL")
IMG_AGENT=$(pin "$IMAGE_PREFIX-agent:$IMAGE_TAG" "$D_AGENT")
IMG_MEMORY=$(pin "$IMAGE_PREFIX-memory:$IMAGE_TAG" "$D_MEMORY")

# ── 1. 找用户 Home ─────────────────────────────────────
say "找用户 Home"
HOME_PATH="$("${SSH[@]}" "ls -d /olares/rootfs/userspace/pvc-userspace-$USER_NAME-*/Home 2>/dev/null | head -1")"
[ -n "$HOME_PATH" ] || die "找不到 pvc-userspace-$USER_NAME-*/Home（用户 $USER_NAME 在这台机器上吗？）"
say "  $HOME_PATH"

[ -f "$REPO/agent/.env" ] || say "没有 agent/.env —— 没有模型 key 时它会答不上话（其余功能正常）"

# ── 1.5 迁一次 hostPath 时代的数据 ──────────────────────
# 会话存档（最后一屏，重连要 resume）和 token 日账本以前躺在代码目录里
# /olares/emergent-desktop/app/agent/{sessions,usage}。现在代码在镜像里只读，
# 这两个目录改成挂 $STATE_DIR。不搬的话：token 账本清零，看起来像"用量丢了"。
# 只在目标为空时搬 —— 不能覆盖新版已经写出来的东西。
say "迁移会话/用量（如果还有旧的 hostPath 数据）"
"${SSH[@]}" "mkdir -p '$STATE_DIR' '$STATE_DIR'/config
  for D in sessions usage; do
    SRC=/olares/emergent-desktop/app/agent/\$D
    if [ -d \"\$SRC\" ] && [ -z \"\$(ls -A '$STATE_DIR'/\$D 2>/dev/null)\" ]; then
      mkdir -p '$STATE_DIR'/\$D && cp -a \"\$SRC\"/. '$STATE_DIR'/\$D/ 2>/dev/null || true
      echo \"  \$D: \$(ls -A '$STATE_DIR'/\$D | wc -l) 个文件\"
    fi
  done; true"

# ── 2. 模型 key + Olares 身份 ───────────────────────────
if [ -f "$REPO/agent/.env" ]; then
  say "写 Secret emergent-desktop-env"
  cat "$REPO/agent/.env" | "${SSH[@]}" \
    "kubectl -n $NS create secret generic emergent-desktop-env --from-env-file=/dev/stdin \
       --dry-run=client -o yaml | kubectl apply -f - >/dev/null && echo ok"
  # 身份凭据是可选的，但没有它就只能"token 被撤了等用户来配"。提醒一次。
  grep -q '^OLARES_' "$REPO/agent/.env" \
    || say "提示：agent/.env 里没有 OLARES_ID / OLARES_PASSWORD，CLI 身份被撤销后要人工处理"
fi

# ── 3. 工作负载 ─────────────────────────────────────────
# Home 的真实路径带随机后缀，猜不得：猜错的表现是"跑起来了、数据写到另一个目录"，
# 而界面上看不出来 —— 只有用户去 Files 里翻的时候才发现东西不见了。
say "apply 工作负载（ReplicaSet，$IMAGE_TAG）"
sed -e "s|__USER_HOME__|$HOME_PATH|g" \
    -e "s|__STATE_DIR__|$STATE_DIR|g" \
    -e "s|__IMAGE_SHELL__|$IMG_SHELL|g" \
    -e "s|__IMAGE_AGENT__|$IMG_AGENT|g" \
    -e "s|__IMAGE_MEMORY__|$IMG_MEMORY|g" \
    "$HERE/desktop-k8s.yaml" | "${SSH[@]}" "kubectl apply -f - 2>&1 | tail -6"

# ReplicaSet 和 Deployment 的一个关键差别：改了 pod template **不会**替换已有的 pod，
# 它只保证"数量对"。不显式删，新镜像永远不生效，而日志里看到的是旧容器的报错 ——
# 那种"我明明改了"的错觉最费时间。
say "重建 pod（让新模板 + 新镜像生效）"
"${SSH[@]}" "kubectl -n $NS delete pod -l app=emergent-desktop --ignore-not-found --wait=false >/dev/null 2>&1 || true"

# kubectl 的 `rollout status` 不认 ReplicaSet（只认 deploy/sts/ds），
# 所以这里自己等：pod 出现 + 三个容器都 Ready。
say "等就绪（最多 180s）"
"${SSH[@]}" "for i in \$(seq 1 90); do
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

回滚到某个提交：./deploy/install.sh --tag sha-1a2b3c4
  标签列表：Hub 仓库的 Tags 页，或 Actions 里那一步输出的 sha-1a2b3c4

桌面回官方：./deploy/install.sh --revert
连工作负载一起删：./deploy/install.sh --uninstall      （数据保留）
EOF

# 早期版本把代码铺在节点上（hostPath）。现在代码在镜像里，那三份是死重量。
if "${SSH[@]}" "test -d /olares/emergent-desktop/app"; then
  echo
  say "节点上还留着旧版 hostPath 代码（现在不用了，可删）"
  echo "  ssh $HOST 'du -sh /olares/emergent-desktop/{app,www,py} 2>/dev/null; rm -rf /olares/emergent-desktop/{app,www,py}'"
fi
