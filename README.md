# Case Reader

A Speechify-style listening app. Add a PDF or paste text; press play; a
warm voice reads along and highlights the words. The voice and your files
live on the device that is listening — nothing is uploaded.

## Share it (free website)

This is the copy you send a friend or a sibling. They open a link, follow
three plain screens, and listen. No install, no account.

**1. Turn on GitHub Pages once** (you). Repo **Settings → Pages → Source:
GitHub Actions**. Then run the **GitHub Pages** workflow, or merge to
`main`. Your site will be:

    https://amaiaaguilar1-create.github.io/case-reader/

**2. They open the link.** Three screens:

1. *Listen to what you read.* → Continue
2. *Save the voice on this device.* About a minute, once. Then it works
   offline.
3. *Add something to hear.* A short sample, a PDF, or pasted text.

After that it is just the reader. Each phone or computer has its own
library — add the file again on a second device.

To try it on your computer before Pages is live:

    cd site
    npm install
    npm run dev

## Run the original Mac app

    ./run.sh

First run creates a venv, installs dependencies, and downloads the Kokoro
fp32 model (311MB) + voices (27MB) from GitHub releases, then opens
http://localhost:8400.

Needs Python 3.10+ (onnxruntime has no 3.9 wheels; macOS still ships 3.9).
`brew install python@3.12`, or point setup at a specific interpreter with
`PYTHON=/path/to/python3.12 ./run.sh`.

## Run the Python app in Codespaces

The original `./run.sh` app (EPUB, Word, article links, original-page view)
still needs a Python process. Codespaces runs that for free. For sharing
with someone who is not technical, use the static site at the top instead.

**1. Start the computer.** On the repo page, click the green **Code** button
-> **Codespaces** tab -> **Create codespace on main**. A code editor opens in
your browser. The first build takes about 5-10 minutes because it downloads
the voice model; later starts take under a minute.

**2. Start the app.** When the build finishes, type this in the terminal
panel at the bottom and press Enter:

    ./run.sh

**3. Open it.** Click the **Ports** tab next to the terminal. Port 8400 will
be listed with a link like

    https://something-random-8400.app.github.dev

That link is yours alone by default. To share it with someone else,
right-click the port -> **Port Visibility** -> **Public**. Anyone with the
link can then use it.

Things worth knowing:

- It falls asleep after about 30 minutes of no use. Reopen it the same way
  (**Code -> Codespaces**, click your existing codespace) and run `./run.sh`
  again. You can also stop it yourself to save hours.
- Port visibility resets to private every time it restarts, so re-do the
  **Public** step if you're sharing a link.
- Your library, reading positions, and cached audio live in the project
  folder (`/workspaces/case-reader`) and survive stop/restart. They're only
  lost if you delete the codespace itself.
- The free plan gives 120 core-hours a month. The default machine has 2
  cores, so that's 60 hours of it being awake. Sleeping or stopped time
  doesn't count.

## What's inside

- core/       parsing (PDF/EPUB/DOCX/TXT/MD), sentence chunking, word-timing
              estimation. Pure functions, fully unit-tested.
- engines/    Kokoro ONNX engine with curated voice presets (warm blends),
              de-click/normalize/trim postprocessing, and a content-addressed
              disk cache.
- server/     FastAPI app: SQLite library, imports, chunk synthesis with a
              background prefetch of the next spoken pack, audio serving.
- site/       static Case Reader: in-browser Kokoro, IndexedDB library,
              three-screen onboarding. This is what GitHub Pages serves.
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

    ./.venv/bin/pytest tests/ -q
    cd site && npm test      # 20 tests: chunker, timing, parsers,
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
