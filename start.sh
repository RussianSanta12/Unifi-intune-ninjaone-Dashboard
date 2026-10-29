#!/usr/bin/env bash
# Starts the dashboard backend in the background and opens it in the browser
# (when there's a desktop). Stop it with ./stop.sh. Linux/macOS counterpart
# of start.ps1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
PID_FILE="$BACKEND/.server.pid"

is_dashboard() {
  # Only trust the PID if it's still a node process — PIDs get reused.
  kill -0 "$1" 2>/dev/null && ps -p "$1" -o comm= 2>/dev/null | grep -q node
}

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is not installed. Install Node 20.6 or newer (Node 22 LTS recommended).'
  exit 1
fi
# --env-file (used below) needs Node 20.6+.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 6) ? 0 : 1)'; then
  echo "Node $(node --version) is too old. Install Node 20.6 or newer (Node 22 LTS recommended)."
  exit 1
fi

# Already running? Don't start a second copy.
if [ -f "$PID_FILE" ]; then
  existing="$(cat "$PID_FILE")"
  if is_dashboard "$existing"; then
    echo "Dashboard is already running (PID $existing). Run ./stop.sh first."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Install dependencies on first run, and again whenever package-lock.json
# changes (e.g. after switching branches).
if [ ! -d "$BACKEND/node_modules" ] || [ "$BACKEND/package-lock.json" -nt "$BACKEND/node_modules/.package-lock.json" ]; then
  echo 'Installing backend dependencies...'
  (cd "$BACKEND" && npm install --no-audit --no-fund)
fi

ENV_FILE="$BACKEND/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$BACKEND/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo 'Created backend/.env from .env.example - fill in your NinjaOne credentials.'
fi

# Read PORT from .env so the health check and browser use the right URL.
# A PORT already in the environment wins (node's --env-file doesn't
# override it either), so `PORT=3001 ./start.sh` works.
port="${PORT:-$(sed -nE 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$ENV_FILE" | head -n 1)}"
url="http://localhost:${port:-3000}"

healthy() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 1 "$url/api/health" >/dev/null 2>&1
  else
    wget -q -T 1 -O /dev/null "$url/api/health" 2>/dev/null
  fi
}

# Something else already on this port would answer the health check below
# and hide that our server failed to bind.
if healthy; then
  echo "Something is already answering at $url (another copy of the dashboard?). Stop it or set a different PORT."
  exit 1
fi

cd "$BACKEND"
nohup node --env-file=.env server.js >server.log 2>server.err.log &
pid=$!
echo "$pid" >"$PID_FILE"

# Wait up to ~10s for the server to answer before opening the browser.
for _ in $(seq 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo 'Server exited during startup. See backend/server.err.log:'
    tail -n 20 server.err.log
    rm -f "$PID_FILE"
    exit 1
  fi
  if healthy; then
    echo "Dashboard running at $url (PID $pid). Logs: backend/server.log"
    if [ "$(uname)" = Darwin ]; then
      open "$url"
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1 &
    fi
    exit 0
  fi
  sleep 0.5
done

echo "Server started (PID $pid) but $url/api/health did not answer yet. Check backend/server.err.log."
