/**
 * Speech synthesis, off the main thread.
 *
 * ONNX inference is a long block of straight-line CPU work. Run it where the
 * page runs and the tab stops responding for as long as it takes -- no
 * scrolling, no pause button, nothing. In here the page stays alive and only
 * the audio is late.
 */
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let engine = null;

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

async function load(id) {
  if (engine) {
    self.postMessage({ type: "loaded", id, threads: self.crossOriginIsolated });
    return;
  }
  engine = await KokoroTTS.from_pretrained(MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: ev => self.postMessage({ type: "progress", ev: plain(ev) }),
  });
  self.postMessage({ type: "loaded", id, threads: self.crossOriginIsolated });
}

/** Progress events carry non-cloneable fields in some versions; keep numbers. */
function plain(ev) {
  if (!ev || typeof ev !== "object") return {};
  const { file, name, status, loaded, total, progress } = ev;
  return { file, name, status, loaded, total, progress };
}

async function speak(id, text, voice) {
  if (!engine) await load(null);
  const started = performance.now();
  const { samples, sr } = pcm(await engine.generate(text, { voice }));
  self.postMessage(
    { type: "audio", id, samples, sr, ms: Math.round(performance.now() - started) },
    [samples.buffer],
  );
}

// One request at a time, in the order they arrive: inference cannot be
// interrupted once it starts, so the only useful place to reorder or drop work
// is before it is sent. That queue lives in tts.js.
self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === "load") await load(id);
    else if (type === "speak") await speak(id, data.text, data.voice);
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message || String(err) });
  }
};
