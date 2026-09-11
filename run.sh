#!/usr/bin/env bash
# Case Reader: one command to set up and run.
set -euo pipefail
cd "$(dirname "$0")"
bash scripts/setup.sh
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8400}"
# In Codespaces the port is forwarded by the platform, so don't open a browser.
if [ -z "${CODESPACES:-}" ]; then
  ( sleep 1.5 && (open "http://localhost:$PORT" || xdg-open "http://localhost:$PORT") >/dev/null 2>&1 ) &
fi
echo "Case Reader running at http://localhost:$PORT"
exec ./.venv/bin/uvicorn server.app:app --host "$HOST" --port "$PORT"
