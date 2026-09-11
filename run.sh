#!/usr/bin/env bash
# LocalSpeech: one command to set up and run.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install -q -U pip
  ./.venv/bin/pip install -q kokoro-onnx soundfile pymupdf ebooklib python-docx \
      fastapi "uvicorn[standard]" python-multipart trafilatura pytest
fi
bash scripts/download_model.sh
echo "LocalSpeech running at http://localhost:8400"
( sleep 1.5 && (open http://localhost:8400 || xdg-open http://localhost:8400) >/dev/null 2>&1 ) &
exec ./.venv/bin/uvicorn server.app:app --port 8400
