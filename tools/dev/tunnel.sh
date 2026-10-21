#!/bin/sh
# 把集群里的 agent 转到本地 —— 不依赖外部域名，也不需要 Olares 登录态。
#
#   sh tools/dev/tunnel.sh          # → http://127.0.0.1:8801/agent/
#   sh tools/dev/tunnel.sh 9000     # 换本机端口
#
# 走两层：本机 ssh 转发到主机，主机上的 kubectl port-forward 到 svc。
# 为什么不用 `kubectl port-forward` 直连：本机没有 kubeconfig（也不该有——
# 那里面是集群私钥），凭据只留在主机上。
#
# 两端端口都给参数：主机上的 8788 常被上一次没退干净的 port-forward 占着，
# 直接复用会 bind: address already in use，看起来像"集群挂了"。
set -e
PORT="${1:-8801}"
RPORT="${2:-8891}"
HOST="${OLARES_HOST:-root@199.68.217.186}"
KEY="${OLARES_KEY:-$HOME/.ssh/olares_ed25519}"

echo "→ http://127.0.0.1:$PORT/agent/   （Ctrl-C 结束）"
echo "  桌面壳：贴底边 / 双击空白唤出 agent；?apps=demo 免登录，?dev=1 看观察窗"
exec ssh -i "$KEY" -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=20 \
  -L "$PORT:127.0.0.1:$RPORT" "$HOST" \
  "kubectl port-forward svc/emergent-agent $RPORT:8788 -n user-space-bbbigdan"
