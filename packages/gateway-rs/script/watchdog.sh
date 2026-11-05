#!/bin/bash
# DynaPM 网关看门狗：本机探测 panel 接口，连续 2 次失败视为卡死 →
# 先 gdb 抓全部线程栈（保留现场证据）再 systemctl restart
LOG=/var/log/dynapm-watchdog.log
FAIL_FILE=/run/dynapm-watchdog-fails
fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)

if ! curl -s -o /dev/null --max-time 5 http://127.0.0.1:5300/_dynapm/panel/; then
  fails=$((fails + 1))
  echo "$(date '+%F %T') probe fail #$fails" >> "$LOG"
  if [ "$fails" -ge 2 ]; then
    pid=$(pidof dynapm)
    if [ -n "$pid" ] && command -v gdb >/dev/null; then
      gdb -p "$pid" -batch -ex "set pagination off" -ex "thread apply all bt 20" \
        >> "/var/log/dynapm-hang-$(date '+%F-%H%M%S').stack" 2>/dev/null
    fi
    echo "$(date '+%F %T') RESTART (stack dumped)" >> "$LOG"
    systemctl restart dynapm
    echo 0 > "$FAIL_FILE"
  else
    echo "$fails" > "$FAIL_FILE"
  fi
else
  [ "$fails" -ne 0 ] && echo 0 > "$FAIL_FILE"
fi
