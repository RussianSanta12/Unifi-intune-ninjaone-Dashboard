#!/usr/bin/env bash
# Stops the dashboard backend started by start.sh.

set -euo pipefail

PID_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backend/.server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo 'Dashboard is not running (no PID file found).'
  exit 0
fi

pid="$(cat "$PID_FILE")"
# Only kill it if the PID still belongs to node — PIDs get reused.
if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o comm= 2>/dev/null | grep -q node; then
  kill "$pid"
  # Give it up to 5s to exit cleanly, then force it.
  for _ in $(seq 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  echo "Dashboard stopped (PID $pid)."
else
  echo 'Dashboard was not running (stale PID file).'
fi

rm -f "$PID_FILE"
