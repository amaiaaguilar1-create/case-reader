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

**2. They open the link** and type the shared password. Send them the
password separately from the link — a text, not the same email. They type it
once per phone or computer; after that the device remembers.

Then three screens:

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

### Try it without the password (sample mode)

For anyone who wants to see what it does but has no password, such as
someone reviewing the project. Either press **Try a sample** on the lock
screen, or send this link, which opens the sample directly:

    https://amaiaaguilar1-create.github.io/case-reader/?sample

It opens a two-page sample case and gives the full listening experience:

- the same voice download, with the same choice between 326 MB and 92 MB;
- the four voices and every speed from 0.75x to 3x;
- the original page, with the sentence and the word being spoken lit up;
- click any sentence, on the page or in the text view, to jump there.

The sample is laid out like a real case so the layout-aware reading shows.
It has a running head on both pages, page numbers, two footnotes, a source
note and a small exhibit table. The voice reads the title and the story,
and skips all of that, along with the raised footnote markers in the text.
Its last footnote says so, on the page, while it is being skipped.

What sample mode does not do: list, open, add to, or save anything in the
library. The sample is fetched with the page and kept in memory only. The
add buttons are hidden, and the rail says the library needs the password.
On the device it saves only the voice and the download-size choice, which
the full app would also use. Leaving is a link back to the lock screen.

The sample is `site/src/sample/hollis-street-bakery.pdf`. Its text was
written for this project; the bakery, its people and its numbers are
invented. Never put case material in it: it is public. The PDF is generated
and committed, so the site build does not need Python. To change the text,
edit `scripts/make_sample_pdf.py` and run:

    ./.venv/bin/python scripts/make_sample_pdf.py

`site/test/sample.test.js` checks that the PDF still has each feature
described above, and `site/test/sample-mode.test.js` checks that sample mode
never touches the library.

### About the password

`site/src/lib/gate.js` holds a PBKDF2-SHA-256 hash of the password and the
salt it was derived with — never the password itself, so a public repo does
not give it away. Each guess costs 310,000 iterations, which makes grinding
through them slow.

Know what it is, though: every line of this site runs in the visitor's
browser, so someone who reads the code can edit around the gate. It stops the
passing stranger and keeps the link out of search results; it is not a vault.
There is nothing behind it to steal — each reader's documents live in their
own browser and never travel — so the gate is about who gets to *use* the
page, not about protecting files.

To change the password, derive a new salt and hash:

    cd site
    node -e 'const {webcrypto:w}=require("crypto");(async()=>{
      const salt=w.getRandomValues(new Uint8Array(16));
      const k=await w.subtle.importKey("raw",new TextEncoder().encode(process.argv[1]),
        "PBKDF2",false,["deriveBits"]);
      const b=await w.subtle.deriveBits({name:"PBKDF2",salt,iterations:310000,
        hash:"SHA-256"},k,256);
      const h=x=>[...new Uint8Array(x)].map(n=>n.toString(16).padStart(2,"0")).join("");
      console.log("SALT="+h(salt));console.log("HASH="+h(b));})()' 'the new password'

Paste both into `gate.js`. Changing them also re-locks every device, because
the remembered value no longer matches.

The test suite leaves the password out on purpose. To exercise the accepting
path locally:

    READER_PASSPHRASE='the password' npm test

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
              shared-password gate, three-screen onboarding, and a
              no-password sample mode. This is what
              GitHub Pages serves. Synthesis runs in a worker; a service
              worker adds the COOP/COEP headers Pages cannot, so ONNX gets
              more than one core.
- web/        single-file frontend, no build step. Speechify-style reader:
              library rail, serif reading view, follow-along word highlight,
              click-to-seek, floating player with speed 0.75-3x
              (pitch-preserved) and voice picker. Space / arrow keys work.

## Engineering notes (findings from validated testing)

- On the CPU, synthesis in the browser is roughly real time: a pack takes
  about as long to make as it takes to hear. WebGPU is about ten times
  faster. Pack size follows from that. Each pack is sized from the speech
  already made and not yet heard, up to 260 characters. The first is a few
  seconds of speech so the first word comes quickly, and later packs grow
  as the queue fills. A sentence is only cut in two when the machine is too
  slow to make it whole in time. A cut sounds like the end of a sentence,
  because Kokoro gives the fragment a falling, finished cadence. The
  ceiling used to be a flat 170, which cut long sentences on every machine.
  Measured on a 12-core Mac with fixed sizes and no queue: 480-char packs
  left a 13-second silence at the first boundary, 260 left 5, and 170 read
  for two minutes with none. Sizing from the queue is what lets 260 work.
- Cross-origin isolation is what makes that possible. Without it onnxruntime
  runs on one core and synthesis is ~2x slower than real time, so playback
  can never keep up. GitHub Pages sends no COOP/COEP headers, so
  site/public/coi-serviceworker.js adds them from a service worker. Safari
  does not support `credentialless` COEP and stays single-threaded.

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

    ./.venv/bin/pytest tests/ -q   # 60 tests: the Python app
    cd site && npm test            # 107 tests: the website

The Python tests cover chunking, word timing, the parsers, PDF layout
(running heads, footnotes, wrapped lines), spoken forms of numbers and
names, and the audio clean-up. The website tests cover the same chunking,
layout and spoken forms, plus the voice backend choice, the synthesis
queue, playback order, the page view, the password gate and sample mode.
One gate test is skipped unless `READER_PASSPHRASE` is set (see above).
GitHub Actions runs `npm test` before every deploy.

## Samples

`samples/localspeech-aria-warm.wav` is a short clip of the default warm voice
preset, for previewing the output without running a synthesis pass.

## Licenses

Kokoro-82M model: Apache-2.0. kokoro-onnx: MIT. All Python deps: MIT/BSD/
Apache. Voices ship with the Kokoro release.

## Known limitations

Scanned PDFs are detected and rejected (no OCR yet). URL import needs
internet, obviously. Highlight timing is estimated, not phoneme-aligned.
