#!/usr/bin/env bash
# Fetches the Kokoro fp32 model (311MB) + voices (27MB) from GitHub releases.
set -euo pipefail
cd "$(dirname "$0")/.."
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f kokoro-v1.0.onnx ] || curl -L --progress-bar -o kokoro-v1.0.onnx "$base/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ]  || curl -L --progress-bar -o voices-v1.0.bin  "$base/voices-v1.0.bin"
echo "Models ready."
