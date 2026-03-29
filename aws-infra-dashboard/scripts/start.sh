#!/usr/bin/env bash
# Start aws-infra-dashboard locally: FastAPI (8000) + Vite dev (5173).
# Run from anywhere: ./scripts/start.sh
set -euo pipefail

DASH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$DASH_ROOT/.." && pwd)"
PID_DIR="$DASH_ROOT/.dev"
mkdir -p "$PID_DIR"

if [[ ! -d "$REPO_ROOT/aws-infra" ]]; then
  echo "error: expected ../aws-infra next to aws-infra-dashboard (got $REPO_ROOT)" >&2
  exit 1
fi

kill_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local p
    p="$(cat "$f")"
    if kill -0 "$p" 2>/dev/null; then
      kill "$p" 2>/dev/null || true
      sleep 0.3
      kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
}

if [[ -f "$PID_DIR/backend.pid" ]] && kill -0 "$(cat "$PID_DIR/backend.pid")" 2>/dev/null; then
  echo "backend already running (pid $(cat "$PID_DIR/backend.pid"))"
else
  kill_pidfile "$PID_DIR/backend.pid"
  cd "$DASH_ROOT/backend"
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
    # shellcheck source=/dev/null
    source .venv/bin/activate
    pip install -r requirements.txt
  else
    # shellcheck source=/dev/null
    source .venv/bin/activate
  fi
  nohup uvicorn main:app --reload --host 127.0.0.1 --port 8000 >>"$PID_DIR/backend.log" 2>&1 &
  echo $! >"$PID_DIR/backend.pid"
  echo "started backend pid $(cat "$PID_DIR/backend.pid") (logs: $PID_DIR/backend.log)"
fi

if [[ -f "$PID_DIR/frontend.pid" ]] && kill -0 "$(cat "$PID_DIR/frontend.pid")" 2>/dev/null; then
  echo "frontend already running (pid $(cat "$PID_DIR/frontend.pid"))"
else
  kill_pidfile "$PID_DIR/frontend.pid"
  cd "$DASH_ROOT/frontend"
  [[ -d node_modules ]] || npm install
  nohup npm run dev >>"$PID_DIR/frontend.log" 2>&1 &
  echo $! >"$PID_DIR/frontend.pid"
  echo "started frontend pid $(cat "$PID_DIR/frontend.pid") (logs: $PID_DIR/frontend.log)"
fi

echo ""
echo "Open http://127.0.0.1:5173  (Vite proxies /api → http://127.0.0.1:8000)"
echo "Stop with: $DASH_ROOT/scripts/stop.sh"
