#!/bin/sh
# 把集群里的 agent 转到本地 —— 不依赖外部域名，也不需要 Olares 登录态。
#
#   sh tools/dev/tunnel.sh          # → http://127.0.0.1:8800/agent/
#   sh tools/dev/tunnel.sh 9000     # 换端口
#
# 走两层：本机 ssh 转发到主机，主机上的 kubectl port-forward 到 svc。
# 为什么不用 `kubectl port-forward` 直连：本机没有 kubeconfig（也不该有——
# 那里面是集群私钥），凭据只留在主机上。
set -e
PORT="${1:-8800}"
HOST="${OLARES_HOST:-root@199.68.217.186}"
KEY="${OLARES_KEY:-$HOME/.ssh/olares_ed25519}"

echo "→ http://127.0.0.1:$PORT/agent/   （Ctrl-C 结束）"
exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
  -L "$PORT:127.0.0.1:8788" "$HOST" \
  'kubectl port-forward svc/emergent-agent 8788:8788 -n user-space-bbbigdan'
