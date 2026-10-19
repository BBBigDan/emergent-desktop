#!/usr/bin/env bash
# 在「官方桌面」和「涌现式壳层」之间切换 desktop 入口。
#   用法：./switch.sh dev | official | status
set -euo pipefail
NS=user-space-bbbigdan

case "${1:-}" in
  dev)
    kubectl patch svc edge-desktop -n "$NS" -p '{"spec":{"selector":{"app":"emergent-shell"}}}'
    echo "→ 已切到开发壳层"
    ;;
  official)
    kubectl patch svc edge-desktop -n "$NS" -p '{"spec":{"selector":{"app":"olares-app"}}}'
    echo "→ 已切回官方桌面"
    ;;
  status)
    echo -n "edge-desktop 指向: "
    kubectl get endpoints edge-desktop -n "$NS" -o jsonpath='{.subsets[*].addresses[*].ip}{"\n"}'
    kubectl get pod -n "$NS" -l app=emergent-shell 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 dev|official|status" >&2
    exit 1
    ;;
esac
