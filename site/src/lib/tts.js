import { speakable } from "./speak.js";
import { estimateWordTimings } from "./timing.js";
import { packForSpeech } from "./chunker.js";
import { encodeWav } from "./wav.js";

export const VOICES = [
  { id: "af_heart", label: "Aria" },
  { id: "af_bella", label: "Bella" },
  { id: "bf_emma", label: "Emma" },
  { id: "am_michael", label: "Michael" },
];

export const DEFAULT_VOICE = "af_heart";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const cache = new Map();
let engine = null;

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

export function voiceReady() {
  return !!engine;
}

export async function loadVoice(onProgress = () => {}) {
  if (engine) {
    onProgress(1);
    return engine;
  }
  const { KokoroTTS } = await import("kokoro-js");
  const totals = new Map();
  const loaded = new Map();
  const report = (ev) => {
    if (!ev) return;
    const key = ev.file || ev.name || "model";
    if (typeof ev.total === "number") totals.set(key, ev.total);
    if (typeof ev.loaded === "number") loaded.set(key, ev.loaded);
    if (typeof ev.progress === "number" && ev.progress <= 1 && !ev.total) {
      onProgress(Math.min(0.99, ev.progress));
      return;
    }
    let t = 0, l = 0;
    for (const [k, n] of totals) {
      t += n;
      l += loaded.get(k) || 0;
    }
    if (t) onProgress(Math.min(0.99, l / t));
    else if (ev.status === "ready" || ev.status === "done") onProgress(1);
  };
  const opts = {
    dtype: "q8",
    device: "wasm",
    progress_callback: report,
  };
  try {
    engine = await KokoroTTS.from_pretrained(MODEL, opts);
  } catch (err) {
    engine = null;
    throw err;
  }
  onProgress(1);
  return engine;
}

export async function synthesize(text, words, voice = DEFAULT_VOICE) {
  if (!engine) await loadVoice();
  const spoken = speakable(text);
  const key = `${voice}|${spoken}`;
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    const result = await engine.generate(spoken, { voice });
    const { samples, sr } = pcm(result);
    const wav = encodeWav(samples, sr);
    const duration = samples.length / sr;
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    return {
      url,
      duration,
      timings: estimateWordTimings(words, duration),
    };
  })();
  cache.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export function packFrom(sentences, startId) {
  const from = sentences.filter(s => s.id >= startId).slice(0, 16);
  const items = from.map(s => [s.id, s.kind || "body", s.text]);
  const ids = packForSpeech(items);
  const picked = ids.map(id => sentences.find(s => s.id === id)).filter(Boolean);
  return {
    ids,
    text: picked.map(s => s.text).join(" "),
    words: picked.flatMap(s => s.words),
    parts: picked.map(s => ({ id: s.id, words: s.words.length })),
    through: ids.at(-1),
  };
}
