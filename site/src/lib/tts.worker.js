/**
 * Speech synthesis, off the main thread.
 *
 * ONNX inference is a long block of straight-line CPU work. Run it where the
 * page runs and the tab stops responding for as long as it takes -- no
 * scrolling, no pause button, nothing. In here the page stays alive and only
 * the audio is late.
 */
import { KokoroTTS } from "kokoro-js";
import { pickBackend, wasmThreads } from "./backend.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAFE = { device: "wasm", dtype: "q8", why: "fallback after a backend failed" };

let engine = null;
let backend = null;
let proven = false;   // a synthesis has come back from this engine intact

/** kokoro-js has returned a few different shapes across versions. */
function pcm(result) {
  if (!result) return { samples: new Float32Array(0), sr: 24000 };
  if (result.audio instanceof Float32Array) {
    return { samples: result.audio, sr: result.sampling_rate || 24000 };
  }
  if (result.audio?.audio instanceof Float32Array) {
    return { samples: result.audio.audio, sr: result.audio.sampling_rate || 24000 };
  }
  if (result instanceof Float32Array) return { samples: result, sr: 24000 };
  return { samples: new Float32Array(0), sr: 24000 };
}

/**
 * Ask onnxruntime for more of the machine than it takes by default.
 *
 * It settles on `min(4, cores/2)` threads, which leaves eight of twelve cores
 * idle. Measured here, through this worker, with fp32: 1.35x real time at the
 * default, 1.58x with the six threads wasmThreads asks for.
 *
 * The import is dynamic and its failure swallowed because this reaches into a
 * package kokoro-js owns rather than one we depend on directly: if that
 * arrangement changes, the voice should get slower, not stop.
 */
async function tuneThreads(chosen) {
  if (chosen.device !== "wasm") return;
  try {
    const { env } = await import("@huggingface/transformers");
    env.backends.onnx.wasm.numThreads = wasmThreads(chosen);
  } catch { /* the default thread count is still a working thread count */ }
}

async function build(chosen) {
  await tuneThreads(chosen);
  return KokoroTTS.from_pretrained(MODEL, {
    dtype: chosen.dtype,
    device: chosen.device,
    progress_callback: ev => self.postMessage({ type: "progress", ev: plain(ev) }),
  });
}

/**
 * Load the engine, and if the chosen backend will not have it, load the old one.
 *
 * The backend decision is made from what the browser claims about itself, and
 * a claim can be wrong: an adapter that reports itself usable can still fail
 * to compile the shaders, and a 326MB download can run the tab out of memory.
 * So a failure here is reported as progress rather than as an error, and the
 * configuration the site shipped with is tried instead.
 */
async function load(id, force = false) {
  if (engine) {
    self.postMessage({ type: "loaded", id, threads: self.crossOriginIsolated, backend });
    return;
  }
  // `force` means an earlier worker was built with the picked backend and
  // then stopped answering -- WebKit does this: it hands out a WebGPU adapter
  // and hangs inside inference, with nothing thrown to catch. Do not probe
  // again, just take the configuration that cannot hang.
  const chosen = force ? { ...SAFE, why: "the faster backend stopped responding" }
    : await pickBackend();
  self.postMessage({ type: "progress", ev: { status: "backend", name: `${chosen.device}/${chosen.dtype}`, why: chosen.why } });
  try {
    engine = await build(chosen);
    backend = chosen;
  } catch (err) {
    if (chosen.device === SAFE.device && chosen.dtype === SAFE.dtype) throw err;
    self.postMessage({ type: "progress", ev: fellBack(chosen, err) });
    engine = await build(SAFE);
    backend = SAFE;
    proven = true;   // nothing left to fall back to; stop second-guessing it
  }
  self.postMessage({ type: "loaded", id, threads: self.crossOriginIsolated, backend });
}

/** Progress events carry non-cloneable fields in some versions; keep numbers. */
function plain(ev) {
  if (!ev || typeof ev !== "object") return {};
  const { file, name, status, loaded, total, progress, why } = ev;
  return { file, name, status, loaded, total, progress, why };
}

function fellBack(chosen, err) {
  return {
    status: "backend",
    name: `${SAFE.device}/${SAFE.dtype}`,
    why: `${chosen.device}/${chosen.dtype} failed (${err?.message || err}); using the`
      + " smaller model, so speech may not keep up at high playback speeds",
  };
}

/**
 * Say `text`, and distrust the first answer.
 *
 * The first synthesis is the one that finds out whether the backend really
 * works: loading a session compiles nothing on some runtimes, so a bad choice
 * only shows up here. Until one clip has come back, a throw is treated as the
 * backend's fault and retried on the safe one -- after that it is the text's
 * fault and reported as an error like any other.
 */
// Speech is quiet, not silent, between words, so the floor is generous enough
// to catch room tone and low enough to keep a soft consonant.
const FLOOR = 0.004;
const WIN_MS = 10;

/**
 * Cut the silence Kokoro leaves at each end of a clip.
 *
 * It returns roughly 320ms of nothing before the first word and 450ms after
 * the last, which is fine for one clip played alone and wrong for ours: a
 * passage is several clips end to end, so that silence lands *inside* the
 * reading as a three-quarter-second hang every few seconds -- including in
 * the middle of a sentence, where a pack was split at a clause break.
 *
 * `tailMs` is how much to leave: a breath where a sentence ended, almost
 * nothing where the words carry straight on. Trimming here rather than in the
 * page also means the duration used for word timings is the duration of
 * actual speech, so the highlight no longer starts a third of a second early.
 */
function trim(samples, sr, tailMs) {
  const win = Math.max(1, Math.round((sr * WIN_MS) / 1000));
  const loud = i => {
    let sum = 0;
    const end = Math.min(i + win, samples.length);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    return Math.sqrt(sum / (end - i)) >= FLOOR;
  };
  let start = 0;
  while (start + win < samples.length && !loud(start)) start += win;
  let end = samples.length;
  while (end - win > start && !loud(end - win)) end -= win;
  if (end <= start) return samples;                    // all quiet; leave it alone

  const head = Math.round((sr * 20) / 1000);           // a hair of room tone
  const tail = Math.round((sr * tailMs) / 1000);
  const from = Math.max(0, start - head);
  const to = Math.min(samples.length, end + tail);
  const cut = samples.slice(from, to);

  // Trimming rarely lands on a zero crossing, and a step into the first sample
  // is a click. Three milliseconds of ramp is inaudible and removes it.
  const ramp = Math.min(Math.round((sr * 3) / 1000), cut.length >> 1);
  for (let i = 0; i < ramp; i++) {
    const g = i / ramp;
    cut[i] *= g;
    cut[cut.length - 1 - i] *= g;
  }
  return cut;
}

async function speak(id, text, voice, tailMs = 180) {
  if (!engine) await load(null, false);
  const started = performance.now();
  let result;
  try {
    result = await engine.generate(text, { voice });
  } catch (err) {
    if (proven) throw err;
    self.postMessage({ type: "progress", ev: fellBack(backend, err) });
    engine = await build(SAFE);
    backend = SAFE;
    proven = true;
    result = await engine.generate(text, { voice });
  }
  proven = true;
  const { samples, sr } = pcm(result);
  const cut = trim(samples, sr, tailMs);
  self.postMessage(
    { type: "audio", id, samples: cut, sr, ms: Math.round(performance.now() - started) },
    [cut.buffer],
  );
}

// One request at a time, in the order they arrive: inference cannot be
// interrupted once it starts, so the only useful place to reorder or drop work
// is before it is sent. That queue lives in tts.js.
self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === "load") await load(id, data.force);
    else if (type === "speak") await speak(id, data.text, data.voice, data.tailMs);
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message || String(err) });
  }
};
