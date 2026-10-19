#!/usr/bin/env bash
# 在「官方」和「涌现式」之间切换入口。
#
#   ./switch.sh desktop dev | desktop official    桌面入口（edge-desktop）
#   ./switch.sh auth    dev | auth     official   登录入口（authelia-svc）
#   ./switch.sh dev | official                     两个一起切
#   ./switch.sh status
#
# 登录入口要比桌面多改一个字段：官方的 auth-front 监听 80，我们的 pod 监听 91，
# 所以切 selector 的同时必须一起改 targetPort，否则服务指过去是空端口（502/默认页）。
set -euo pipefail
NS=user-space-bbbigdan

desktop() {
  case "$1" in
    dev)      kubectl patch svc edge-desktop -n "$NS" -p '{"spec":{"selector":{"app":"emergent-shell"}}}' ;;
    official) kubectl patch svc edge-desktop -n "$NS" -p '{"spec":{"selector":{"app":"olares-app"}}}' ;;
    *) echo "usage: $0 desktop dev|official" >&2; exit 1 ;;
  esac
  echo "→ 桌面入口：$1"
}

auth() {
  case "$1" in
    dev)
      kubectl patch svc authelia-svc -n "$NS" -p '{"spec":{"selector":{"app":"emergent-auth"}}}'
      kubectl patch svc authelia-svc -n "$NS" --type=json \
        -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":91}]'
      ;;
    official)
      kubectl patch svc authelia-svc -n "$NS" -p '{"spec":{"selector":{"app":"authelia"}}}'
      kubectl patch svc authelia-svc -n "$NS" --type=json \
        -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":80}]'
      ;;
    *) echo "usage: $0 auth dev|official" >&2; exit 1 ;;
  esac
  echo "→ 登录入口：$1"
}

status() {
  printf '%-14s selector=%s targetPort=%s\n' edge-desktop \
    "$(kubectl get svc edge-desktop -n "$NS" -o jsonpath='{.spec.selector.app}')" \
    "$(kubectl get svc edge-desktop -n "$NS" -o jsonpath='{.spec.ports[0].targetPort}')"
  printf '%-14s selector=%s targetPort=%s\n' authelia-svc \
    "$(kubectl get svc authelia-svc -n "$NS" -o jsonpath='{.spec.selector.app}')" \
    "$(kubectl get svc authelia-svc -n "$NS" -o jsonpath='{.spec.ports[0].targetPort}')"
  kubectl get pod -n "$NS" -l 'app in (emergent-shell,emergent-auth)' --no-headers 2>/dev/null || true
}

case "${1:-}" in
  desktop) desktop "${2:-}" ;;
  auth)    auth "${2:-}" ;;
  dev)     desktop dev; auth dev ;;
  official) desktop official; auth official ;;
  status)  status ;;
  *) echo "usage: $0 desktop|auth <dev|official> | dev | official | status" >&2; exit 1 ;;
esac
