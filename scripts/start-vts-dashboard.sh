#!/usr/bin/env bash
# Start the KIS VTS paper dashboard on port 3939.
# Paper trading only: the app always boots SAFE_LOCKED; this script never unlocks anything.
# Usage: scripts/start-vts-dashboard.sh [--background]
set -euo pipefail
PORT="${PORT:-3939}"
HOST="${HOST:-0.0.0.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Dashboard already listening on port ${PORT}; not starting another."
  exit 0
fi
if [ "${1:-}" = "--background" ]; then
  LOG_DIR="${LOG_DIR:-/tmp/kisdash}"
  mkdir -p "$LOG_DIR"
  setsid nohup npx next dev -p "$PORT" -H "$HOST" > "$LOG_DIR/dev.log" 2>&1 < /dev/null &
  echo "Dashboard starting in background on http://localhost:${PORT} (log: $LOG_DIR/dev.log)"
else
  exec npx next dev -p "$PORT" -H "$HOST"
fi