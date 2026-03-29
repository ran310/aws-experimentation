#!/usr/bin/env bash
# Stop processes started by scripts/start.sh
set -euo pipefail

DASH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$DASH_ROOT/.dev"

stop_one() {
  local name="$1" pidfile="$PID_DIR/${1}.pid"
  if [[ ! -f "$pidfile" ]]; then
    echo "$name: no pid file ($pidfile), skipping"
    return 0
  fi
  local p
  p="$(cat "$pidfile")"
  if kill -0 "$p" 2>/dev/null; then
    echo "stopping $name (pid $p)"
    kill "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$p" 2>/dev/null || break
      sleep 0.3
    done
    if kill -0 "$p" 2>/dev/null; then
      echo "force kill $name (pid $p)"
      kill -9 "$p" 2>/dev/null || true
    fi
  else
    echo "$name: pid $p not running"
  fi
  rm -f "$pidfile"
}

stop_one backend
stop_one frontend

echo "done."
