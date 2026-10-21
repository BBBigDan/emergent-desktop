#!/bin/sh
# 在 shell pod 里跑：验证 nginx → agent 的整条链路（含 SSE 下行 + POST 上行）
SID="ng$RANDOM"
BASE="http://127.0.0.1:91/agent"

curl -sN --max-time 25 "$BASE/api/events?sid=$SID" > /tmp/sse.txt 2>&1 &
sleep 1.5
curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sid\":\"$SID\",\"t\":\"ask\",\"text\":\"机器怎么有点卡\"}" \
  "$BASE/api/send" > /dev/null
sleep 12
echo "=== 事件 ==="
grep -o '"t":"[a-z_]*"' /tmp/sse.txt | sort | uniq -c
echo "=== 场景 ==="
grep -o '"op":"[a-z]*"' /tmp/sse.txt | head -4
grep -o '"kind":"trace"[^}]*' /tmp/sse.txt | head -c 120
echo
echo "=== 说话 ==="
grep -o '"t":"say","text":"[^"]*"' /tmp/sse.txt | head -3
