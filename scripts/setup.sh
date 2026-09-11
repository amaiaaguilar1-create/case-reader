#!/usr/bin/env bash
# Creates the venv, installs dependencies, and fetches the model.
set -euo pipefail
cd "$(dirname "$0")/.."

# onnxruntime (via kokoro-onnx) needs Python 3.10+. macOS still ships 3.9,
# so pick a new enough interpreter rather than failing deep inside pip.
find_python() {
  for p in "${PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3; do
    [ -n "$p" ] || continue
    command -v "$p" >/dev/null 2>&1 || continue
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      command -v "$p"
      return 0
    fi
  done
  return 1
}

if [ ! -d .venv ]; then
  if ! py=$(find_python); then
    echo "Case Reader needs Python 3.10 or newer (found: $(python3 --version 2>&1))." >&2
    echo "Install it with one of:" >&2
    echo "  brew install python@3.12" >&2
    echo "  https://www.python.org/downloads/macos/" >&2
    echo "Then re-run ./run.sh, or set PYTHON=/path/to/python3.12" >&2
    exit 1
  fi
  echo "Using $py ($("$py" --version 2>&1))"
  "$py" -m venv .venv
  ./.venv/bin/pip install -q -U pip
  ./.venv/bin/pip install -q -r requirements.txt
fi
bash scripts/download_model.sh
