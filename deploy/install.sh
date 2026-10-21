#!/usr/bin/env bash
# 把 agent 装成一个 **Olares 应用**：市场里能装、能卸，数据在用户的 Home 里。
#
#   ./deploy/install.sh                 # 装或升级（幂等）
#   ./deploy/install.sh --uninstall     # 卸干净（保留数据）
#   ./deploy/install.sh --lint          # 只校验 chart，不装
#
# 为什么走市场（`olares-cli market`）而不是 `helm upgrade --install`：
#   helm 直接装能跑，但它绕过安装器 —— 没有 Application 记录、没有 entrance 注册、
#   没有 entitlement，桌面上看不到图标，从市场点进来是 404。
#   走市场的代价是要先上传 chart，收益是"卸载"这件事真的成立（`--uninstall` 一行）。
#
# 代码仍然不进镜像：上传到 appData，重启进程即生效。原因见 deploy/README.md。
set -euo pipefail

HOST="${OLARES_HOST:-root@199.68.217.186}"
KEY="${OLARES_KEY:-$HOME/.ssh/olares_ed25519}"
APPID=emergentdesktop
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CHART="$HERE/$APPID"
REMOTE=/olares/emergent-desktop
VER="$(sed -n 's/^version: *//p' "$CHART/Chart.yaml")"

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$HOST")

say() { printf '\033[36m→\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 安装器给应用建的命名空间是 <appid>-<用户名>，用户名要从已装的应用里读，
# 不让人再填一遍（填错的表现是"装上了但桌面上没有"）。
NS="$("${SSH[@]}" "kubectl get ns -o name | sed 's|namespace/||' | grep -E '^${APPID}-' | head -1")"

# ── 卸载 ────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  say "从市场卸载 $APPID"
  "${SSH[@]}" "olares-cli market uninstall $APPID 2>&1 | tail -2"
  say "数据保留在 Home/Agent 与 Data/$APPID —— 卸载不该带走记忆"
  say "要连数据一起清："
  say "  ssh $HOST 'rm -rf /olares/rootfs/userspace/pvc-userspace-*/{Home/Agent,Data/$APPID}'"
  exit 0
fi

# ── 1. 校验 ─────────────────────────────────────────────
# lint 是这个包**唯一**能提前拦住错误的地方：它跑的是市场入库同一条流水线
# （清单结构、helm dry-run、hostPath、资源上限、版本一致性）。
say "传 chart 并校验（$APPID $VER）"
tar czf - -C "$HERE" "$APPID" | "${SSH[@]}" "rm -rf '$REMOTE/$APPID'; mkdir -p '$REMOTE'; tar xzf - -C '$REMOTE'"
"${SSH[@]}" "olares-cli chart lint '$REMOTE/$APPID'" || die "chart 校验没过，先修上面那条"

if [ "${1:-}" = "--lint" ]; then exit 0; fi

# ── 2. 上传 + 安装 ──────────────────────────────────────
say "上传到本地源"
# 同一个版本号只能上传一次（HTTP 409）。这不是错误 —— 版本没变就说明包也没变，
# 直接跳过上传继续装：仓库里改了代码要重传的是代码（下面第 4 步），不是 chart。
UP="$("${SSH[@]}" "cd '$REMOTE' && rm -f $APPID-$VER.tgz && tar czf $APPID-$VER.tgz $APPID \
  && olares-cli market upload $REMOTE/$APPID-$VER.tgz 2>&1 | tail -2")"
printf '%s\n' "$UP"
if printf '%s\n' "$UP" | grep -q "already exists"; then
  say "本地源里已有 $VER，跳过上传"
elif ! printf '%s\n' "$UP" | grep -q "chart uploaded"; then
  die "上传失败，看上面那条"
fi

# 状态决定动词。直接 grep 应用名会撞到一行 state=uninstalled 的旧记录
# （卸载过的应用会一直留在状态表里），于是"首次安装"被当成"升级"——
# 而 upgrade 在 uninstalled 状态下会被后端拒掉。
STATE="$("${SSH[@]}" "olares-cli market status -a 2>/dev/null | awk '\$1==\"$APPID\"{print \$3}' | head -1")"
say "当前状态：${STATE:-（没装过）}"
case "$STATE" in
  running|stopped|stopFailed|upgradeFailed|applyEnvFailed)
    say "升级到 $VER"
    "${SSH[@]}" "olares-cli market upgrade $APPID -s upload --version $VER 2>&1 | tail -3" ;;
  installing|upgrading|uninstalling|pending|initializing|uninstalled|"")
    say "安装 $VER"
    "${SSH[@]}" "olares-cli market install $APPID -s upload --version $VER 2>&1 | tail -3" ;;
  *)
    die "这个状态不认识：$STATE。先 olares-cli market status -a 看一眼" ;;
esac

# ── 3. 等 Deployment 出现，读出安装器给的路径 ────────────
# 这两个路径不能由脚本猜：appData 是 .../Data/<appid>，userData 是 .../Home，
# 但 pvc 目录名带随机后缀。猜错的后果是"跑起来了、数据写到另一个目录"。
say "等安装器建好 Deployment"
for i in $(seq 1 40); do
  NS="$("${SSH[@]}" "kubectl get ns -o name 2>/dev/null | sed 's|namespace/||' | grep -E '^${APPID}-' | head -1")"
  if [ -n "$NS" ] && "${SSH[@]}" "kubectl -n $NS get deploy $APPID >/dev/null 2>&1"; then break; fi
  sleep 3
  [ "$i" = 40 ] && die "60 秒了还没有 Deployment。看市场状态：olares-cli market status -a"
done

PATHS="$("${SSH[@]}" "kubectl -n $NS get deploy $APPID -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}={.hostPath.path}{\"\\n\"}{end}'")"
APPDATA="$(printf '%s\n' "$PATHS" | sed -n 's/^app=//p')"
USERDATA="$(printf '%s\n' "$PATHS" | sed -n 's/^userspace=//p')"
[ -n "$APPDATA" ] && [ -n "$USERDATA" ] || die "读不到挂载路径：$PATHS"
say "appData  $APPDATA"
say "userHome $USERDATA"

# ── 4. 代码 ────────────────────────────────────────────
say "同步代码"
# 排除的都得排：.env 走 Secret 不走卷；sessions/usage/memory 是运行时数据；
# .kube 是集群凭据 —— 进卷等于把这份权限发给任何能 exec 进来的人。
tar czf - -C "$REPO" \
  --exclude='.kube' --exclude='sessions' --exclude='usage' --exclude='memory' \
  --exclude='.env' --exclude='.tools' --exclude='__pycache__' --exclude='.venv' \
  agent shell | "${SSH[@]}" "mkdir -p '$APPDATA' && tar xzf - -C '$APPDATA'"

# ── 5. 模型 key ────────────────────────────────────────
[ -f "$REPO/agent/.env" ] && {
  say "写 Secret $APPID-env（从 agent/.env）"
  cat "$REPO/agent/.env" | "${SSH[@]}" \
    "kubectl create secret generic $APPID-env -n $NS --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f - >/dev/null && echo ok"
} || say "没有 agent/.env，跳过 Secret（用镜像外的 key 时是正常的）"

# ── 6. 让代码生效 ──────────────────────────────────────
# 代码是卷不是镜像：helm 升级时 pod template 没变，Deployment 不会重建 ——
# 不显式 restart，新传的代码一行都不会跑，而市场里显示"已安装、运行中"。
say "重启进程"
"${SSH[@]}" "kubectl -n $NS rollout restart deploy/$APPID >/dev/null && echo restarted"

say "等就绪（最多 120s）"
"${SSH[@]}" "kubectl -n $NS rollout status deploy/$APPID --timeout=120s 2>&1 | tail -1" || {
  "${SSH[@]}" "kubectl -n $NS get pod; kubectl -n $NS logs deploy/$APPID -c agent --tail=20"
  die "没起来，日志在上面"
}

say "健康检查"
"${SSH[@]}" "kubectl -n $NS exec deploy/$APPID -c agent -- node -e \"
  fetch('http://127.0.0.1:8788/agent/api/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR',e.message))\""

cat <<EOF

装好了。桌面上会出现「涌现式桌面」；入口（登录后）：
  https://$APPID.<你的用户名>.olares.com/

数据在哪（Files 里都看得见）：
  代码      $APPDATA
  记忆/人格  $USERDATA/Agent
  会话/账本  $APPDATA/{sessions,usage}

改代码后让新代码生效：
  ./deploy/install.sh            # 重传代码 + rollout restart

卸载：./deploy/install.sh --uninstall
EOF
