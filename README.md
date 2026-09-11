# Case Reader

A Speechify-style listening app that runs entirely on your own computer.
Import PDFs, EPUBs, Word files, articles, or pasted text; press play; the
words highlight as a warm natural voice reads to you. Nothing leaves the
machine and it works with Wi-Fi off after the first model download.

## Run it

    ./run.sh

First run creates a venv, installs dependencies, and downloads the Kokoro
fp32 model (311MB) + voices (27MB) from GitHub releases, then opens
http://localhost:8400.

Needs Python 3.10+ (onnxruntime has no 3.9 wheels; macOS still ships 3.9).
`brew install python@3.12`, or point setup at a specific interpreter with
`PYTHON=/path/to/python3.12 ./run.sh`.

## Run it on the web (GitHub Codespaces)

The app needs a real Python process and ~340MB of model on disk, so it can't
go on a static host like GitHub Pages. Codespaces runs it as-is:

On the repo, click **Code -> Codespaces -> Create codespace on main**. The
devcontainer pins Python 3.12 and runs `scripts/setup.sh`, then serving with

    ./run.sh

forwards port 8400 to a `*.app.github.dev` URL. The port is private to your
account by default; set it to public in the **Ports** tab to share a link.
Codespaces sleeps after ~30 minutes idle, so this is on-demand, not always-on.

## What's inside

- core/       parsing (PDF/EPUB/DOCX/TXT/MD), sentence chunking, word-timing
              estimation. Pure functions, fully unit-tested.
- engines/    TTSEngine interface + Kokoro ONNX engine with curated voice
              presets (warm blends), de-click/normalize/trim postprocessing,
              and a content-addressed disk cache.
- server/     FastAPI app: SQLite library, imports, chunk synthesis with a
              background prefetch queue (3 chunks ahead), audio serving.
- web/        single-file frontend, no build step. Speechify-style reader:
              library rail, serif reading view, follow-along word highlight,
              click-to-seek, floating player with speed 0.75-3x
              (pitch-preserved) and voice picker. Space / arrow keys work.

## Engineering notes (findings from validated testing)

- kokoro-onnx exposes no word timestamps; timings are estimated by
  distributing measured audio duration across words with punctuation-aware
  weights. Drift is small at sentence scale.
- The int8 model is unstable for some voice/text pairs (speech collapses to
  near-silence, single-sample spikes at amplitude 300+, blended style
  vectors explode to float-max). The fp32 model passes a 24/24 voice x text
  stability matrix and stable blends, so fp32 is the default; int8 runs
  with a warning if it's the only model present.
- kokoro-onnx's built-in trimmer overflows on float16 energy and can trim
  entire clips to zero; synthesis runs trim=False and the engine does its
  own float64 de-click -> peak-normalize (0.92) -> silence trim.
- User playback speed is applied in the browser via playbackRate with
  preservesPitch; synthesis always runs at each preset's base prosody
  speed, so the cache holds one entry per voice regardless of speed.

## Tests

    ./.venv/bin/pytest tests/ -q      # 20 tests: chunker, timing, parsers,
                                      # postprocessing regressions

## Samples

`samples/localspeech-aria-warm.wav` is a short clip of the default warm voice
preset, for previewing the output without running a synthesis pass.

## Licenses

Kokoro-82M model: Apache-2.0. kokoro-onnx: MIT. All Python deps: MIT/BSD/
Apache. Voices ship with the Kokoro release.

## Known limitations

Scanned PDFs are detected and rejected (no OCR yet). URL import needs
internet, obviously. Highlight timing is estimated, not phoneme-aligned.
