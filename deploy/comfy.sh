#!/usr/bin/env bash
# ComfyUI（纯 CPU）· 起 / 停 / 看
#
#   ./deploy/comfy.sh             # 起（幂等）：apply → 等就绪 → 把 COMFY_URL 写进 Secret → 重启 agent
#   ./deploy/comfy.sh --status    # 只看状态（不动任何东西）
#   ./deploy/comfy.sh --logs      # 跟日志（下载模型 / ComfyUI 启动都在这）
#   ./deploy/comfy.sh --down      # 删掉工作负载（**模型和输出留在盘上**）
#   ./deploy/comfy.sh --purge     # 连盘上的模型一起删（约 2.1GB）
#
# 为什么是自己起的 ReplicaSet 而不是市场应用：见 comfy-cpu.yaml 顶部的注释
# （市场那个 ComfyUI 没有 CPU 档，且要求 20~22Gi 内存）。
#
# 首次启动会下 2.1GB 权重（Lykon/dreamshaper-8-lcm，免登录）。之后重启秒起，
# 因为 /root 整个挂在 hostPath 上。
set -euo pipefail

HOST="${OLARES_HOST:-root@199.68.217.186}"
KEY="${OLARES_KEY:-$HOME/.ssh/olares_ed25519}"
USER_NAME="${OLARES_USER:-bbbigdan}"
NS="user-space-$USER_NAME"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="${COMFY_DIR:-/olares/emergent-desktop/comfy}"
MODEL_FILE="${MODEL_FILE:-dreamshaper8_lcm.safetensors}"
MODEL_URL="${MODEL_URL:-https://huggingface.co/Lykon/dreamshaper-8-lcm/resolve/main/DreamShaper8_LCM.safetensors}"
# agent 侧只认这一个变量；服务名就在同一个命名空间里，不用走外部域名
COMFY_URL_INNER="${COMFY_URL_INNER:-http://comfyui:8188}"

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$HOST")
say() { printf '\033[36m→\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ACTION="up"
case "${1:-}" in
  --status) ACTION=status ;;
  --logs)   ACTION=logs ;;
  --down)   ACTION=down ;;
  --purge)  ACTION=purge ;;
  "" ) ;;
  -*) die "不认识的参数：$1" ;;
esac

# ── 看 ───────────────────────────────────────────────────
if [ "$ACTION" = status ]; then
  "${SSH[@]}" "kubectl -n $NS get pod -l app=comfyui -o wide 2>/dev/null || true
    echo '--- 服务 ---'
    kubectl -n $NS get svc comfyui 2>/dev/null || echo '（没有 comfyui 服务）'
    echo '--- 模型 ---'
    P=\$(kubectl -n $NS get pod -l app=comfyui -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    if [ -n \"\$P\" ]; then
      kubectl -n $NS exec \$P -c comfyui -- sh -lc 'ls -lh /root/ComfyUI/models/checkpoints 2>/dev/null' || true
      kubectl -n $NS exec \$P -c comfyui -- sh -lc 'curl -s -m 5 http://127.0.0.1:8188/system_stats' 2>/dev/null | head -c 400 || true
    fi
    echo
    echo '--- agent 看到的 COMFY_URL ---'
    kubectl -n $NS get secret emergent-desktop-env -o go-template='{{index .data \"COMFY_URL\" | base64decode}}' 2>/dev/null || echo '（Secret 里没有 COMFY_URL）'
    echo"
  exit 0
fi

if [ "$ACTION" = logs ]; then
  "${SSH[@]}" "P=\$(kubectl -n $NS get pod -l app=comfyui -o jsonpath='{.items[0].metadata.name}')
    kubectl -n $NS logs -f \$P -c fetch-model 2>/dev/null &
    kubectl -n $NS logs -f \$P -c comfyui 2>/dev/null"
  exit 0
fi

# ── 停 ───────────────────────────────────────────────────
if [ "$ACTION" = down ] || [ "$ACTION" = purge ]; then
  say "删工作负载（模型保留在 $COMFY_DIR）"
  "${SSH[@]}" "kubectl -n $NS delete rs comfyui --ignore-not-found --wait=true --timeout=60s >/dev/null
    kubectl -n $NS delete svc comfyui --ignore-not-found >/dev/null
    echo done"
  if [ "$ACTION" = purge ]; then
    say "删盘上的模型与输出"
    "${SSH[@]}" "rm -rf '$COMFY_DIR' && echo removed"
  fi
  # 留着 COMFY_URL 的话，agent 会一直说"连不上"—— 这是实话，但不该由一次 --down 制造。
  say "把 Secret 里的 COMFY_URL 清掉（agent 会退回默认地址并如实说没接）"
  "${SSH[@]}" "kubectl -n $NS patch secret emergent-desktop-env --type=merge \
    -p '{\"data\":{\"COMFY_URL\":\"\"}}' >/dev/null 2>&1 || true; echo ok"
  exit 0
fi

# ── 起 ───────────────────────────────────────────────────
# 先探两个镜像的 manifest：3.6GB 的拉取如果因为标签写错/仓库私有失败，
# 表现是 pod 卡在 ImagePullBackOff，而那时候要看的东西只剩事件里的 401。
# 匿名探测一次只花一秒。
say "探测镜像（匿名）"
PROBE=$(cat <<'EOS'
probe() {
  R="$1"; T="$2"
  U="https://auth.docker.io/token?service=registry.docker.io&scope=repository:$R:pull"
  TOK=$(curl -s -m 10 "$U" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $TOK" \
      -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
      "https://registry-1.docker.io/v2/$R/manifests/$T")
  echo "  $R:$T → HTTP $C"
  [ "$C" = 200 ] || return 7
}
probe yanwk/comfyui-boot cpu || exit 7
probe library/node 22-alpine || exit 7
EOS
)
"${SSH[@]}" sh -s <<<"$PROBE" || die "镜像拉不到 —— 线上没动过"

say "准备目录 $COMFY_DIR/root"
"${SSH[@]}" "mkdir -p '$COMFY_DIR/root' && echo ok"

# `-n $NS` 不能漏：漏了 kubectl 用 kubeconfig 的默认命名空间（default），
# pod 照样起来、模型照样下，但 agent 在 user-space-* 里找不到 `comfyui` 这个服务名 ——
# 表现是"明明起来了，画图还是连不上"。（第一次就踩了这一下）
say "apply（ReplicaSet + Service，命名空间 $NS）"
sed -e "s|__COMFY_DIR__|$COMFY_DIR|g" \
    -e "s|__MODEL_URL__|$MODEL_URL|g" \
    -e "s|__MODEL_FILE__|$MODEL_FILE|g" \
    "$HERE/comfy-cpu.yaml" | "${SSH[@]}" "kubectl -n $NS apply -f - 2>&1 | tail -4"

# 首次要下 2.1GB，别催它；但也不能默默等 —— 把 init 容器的进度漏一行出来。
say "等就绪（首次要下 $MODEL_FILE，2GB 级；最多等 12 分钟）"
if ! "${SSH[@]}" "for i in \$(seq 1 144); do
    R=\$(kubectl -n $NS get pod -l app=comfyui -o jsonpath='{.items[0].status.containerStatuses[*].ready}' 2>/dev/null)
    case \"\$R\" in 'true') echo ready; exit 0;; esac
    if [ \$((i % 10)) = 0 ]; then
      echo \"  …\$((i*5))s  \$(kubectl -n $NS get pod -l app=comfyui -o jsonpath='{.items[0].status.phase}' 2>/dev/null)\"
      kubectl -n $NS logs -l app=comfyui -c fetch-model --tail=1 2>/dev/null | sed 's/^/    /'
    fi
    sleep 5
  done
  echo '--- 事件 ---'
  kubectl -n $NS describe pod -l app=comfyui 2>&1 | sed -n '/Events:/,\$p' | tail -12
  echo '--- 日志 ---'
  kubectl -n $NS logs -l app=comfyui -c comfyui --tail=20 2>&1 | tail -20
  exit 1"; then
  die "没起来，输出在上面"
fi

# 起来之后先确认真能回话，再改 Secret —— 反过来的话 agent 会先拿到一个连不上的地址。
say "探测 /system_stats（从 comfyui pod 自己打）"
"${SSH[@]}" "P=\$(kubectl -n $NS get pod -l app=comfyui -o jsonpath='{.items[0].metadata.name}')
  kubectl -n $NS exec \$P -c comfyui -- curl -s -m 8 http://127.0.0.1:8188/system_stats 2>/dev/null | head -c 300; echo"

# 写 COMFY_URL：agent 的 env 来自 Secret（install.sh 从 agent/.env 灌整份）。
# 用 merge patch 只加这一个键，别的键（MODEL_KEY 等）原样不动。
say "把 COMFY_URL=$COMFY_URL_INNER 写进 Secret emergent-desktop-env"
# **JSON 在本地拼好再发**。以前是在远端 shell 里展开 `$B` —— 三层引号一错，
# 写进去的成了字面量 `$B`，kubectl 报 `illegal base64 data at input byte 0`，
# 而我们那句 `|| echo` 又把失败说成"没有这个 Secret"，看起来像另一种毛病。
B64=$(printf %s "$COMFY_URL_INNER" | base64 | tr -d '\n')
PATCH_JSON="{\"data\":{\"COMFY_URL\":\"$B64\"}}"
"${SSH[@]}" "kubectl -n $NS patch secret emergent-desktop-env --type=merge -p '$PATCH_JSON' >/dev/null 2>&1 \
  && echo ok || { echo '写 Secret 失败（这个 Secret 存在吗？先跑 ./deploy/install.sh）'; exit 1; }" \
  || die "Secret 没写进去，agent 拿不到 COMFY_URL"
GOT=$("${SSH[@]}" "kubectl -n $NS get secret emergent-desktop-env \
  -o go-template='{{index .data \"COMFY_URL\" | base64decode}}' 2>/dev/null")
[ "$GOT" = "$COMFY_URL_INNER" ] || die "Secret 里的 COMFY_URL 是「$GOT」，不是 $COMFY_URL_INNER"
echo "  Secret 回读：$GOT"

# env 是进程启动时读的：不重建 pod，agent 里那个 COMFY_URL 还是旧的。
say "重建 agent pod（让它读到新的 COMFY_URL）"
"${SSH[@]}" "kubectl -n $NS delete pod -l app=emergent-desktop --ignore-not-found --wait=false >/dev/null 2>&1 || true
  for i in \$(seq 1 60); do
    R=\$(kubectl -n $NS get pod -l app=emergent-desktop -o jsonpath='{.items[0].status.containerStatuses[*].ready}' 2>/dev/null)
    case \"\$R\" in 'true true true') echo ready; exit 0;; esac
    sleep 2
  done
  echo '（agent 没在 120s 内就绪，看 kubectl -n $NS get pod）'" || true

# 最后从 agent 的角度验一次：它才是真正要连 ComfyUI 的那一方
say "从 agent 那边探一次（这才是它看到的网络）"
# **不能取 items[0]**：刚删过 pod，列表里还有正在 Terminating 的那个，
# items[0] 经常是它 —— 于是 exec 报 `pods "xxx" not found`，看起来像"agent 起不来"。
# 按 ready 状态挑，才拿得到真正在跑的那个。
"${SSH[@]}" "P=\$(kubectl -n $NS get pod -l app=emergent-desktop \
    -o jsonpath='{range .items[*]}{.metadata.name}{\"|\"}{.status.containerStatuses[*].ready}{\"\\n\"}{end}' \
    2>/dev/null | grep '|true true true' | cut -d'|' -f1 | head -1)
  if [ -n \"\$P\" ]; then
    kubectl -n $NS exec \$P -c agent -- node -e \"
      fetch('$COMFY_URL_INNER/system_stats').then(r=>r.json()).then(j=>{
        const d=(j.devices||[])[0]||{};
        console.log('ok  comfyui', j.system?.comfyui_version||'', '| 设备:', d.name||'?', d.type||'', '| 显存:', d.vram_total||0);
      }).catch(e=>{console.log('连不上：'+e.message); process.exit(1)})
    \"
  else
    echo '（没找到 ready 的 agent pod，跳过这一步）'
  fi"

cat <<EOF

起好了。agent 现在把图交给它：$COMFY_URL_INNER
  出图：桌面上直接说「画一张……」（4~6 步、512×512，8 核大约 20~60 秒）
  看状态：./deploy/comfy.sh --status
  跟日志：./deploy/comfy.sh --logs
  停掉（模型留在盘上）：./deploy/comfy.sh --down
  连模型一起删：./deploy/comfy.sh --purge

模型文件：$COMFY_DIR/root/ComfyUI/models/checkpoints/$MODEL_FILE
出图文件：$COMFY_DIR/root/ComfyUI/output/

换模型（比如以后有卡了用 sd-turbo）：
  MODEL_URL=… MODEL_FILE=sd-turbo.safetensors ./deploy/comfy.sh
  同时给 agent 加 COMFY_MODEL=sd-turbo.safetensors（模板里的默认模型名会挡住它）
EOF
