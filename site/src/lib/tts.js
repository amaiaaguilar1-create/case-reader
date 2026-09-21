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

const cache = new Map();
const pending = new Map();
let worker = null;
let ready = false;
let onProgressNow = () => {};
let seq = 0;

function boot() {
  if (worker) return worker;
  worker = new Worker(new URL("./tts.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      report(data.ev);
      return;
    }
    const slot = pending.get(data.id);
    if (!slot) return;
    pending.delete(data.id);
    if (data.type === "error") slot.reject(new Error(data.message));
    else slot.resolve(data);
  };
  worker.onerror = e => {
    const err = new Error(e.message || "The voice stopped unexpectedly.");
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
    worker = null;
    ready = false;
  };
  return worker;
}

function ask(message, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    boot().postMessage({ ...message, id }, transfer);
  });
}

const totals = new Map();
const loaded = new Map();
function report(ev) {
  if (!ev) return;
  const key = ev.file || ev.name || "model";
  if (typeof ev.total === "number") totals.set(key, ev.total);
  if (typeof ev.loaded === "number") loaded.set(key, ev.loaded);
  if (typeof ev.progress === "number" && ev.progress <= 1 && !ev.total) {
    onProgressNow(Math.min(0.99, ev.progress));
    return;
  }
  let t = 0, l = 0;
  for (const [k, n] of totals) {
    t += n;
    l += loaded.get(k) || 0;
  }
  if (t) onProgressNow(Math.min(0.99, l / t));
  else if (ev.status === "ready" || ev.status === "done") onProgressNow(1);
}

export function voiceReady() {
  return ready;
}

let loading = null;
export async function loadVoice(onProgress = () => {}) {
  onProgressNow = onProgress;
  if (ready) {
    onProgress(1);
    return;
  }
  if (!loading) {
    loading = ask({ type: "load" }).finally(() => { loading = null; });
  }
  try {
    const done = await loading;
    ready = true;
    if (!done.threads) {
      // Without cross-origin isolation ONNX runs on one core. The service
      // worker in index.html supplies the headers a static host cannot.
      console.info("Case Reader: voice is running single-threaded.");
    }
    onProgress(1);
  } finally {
    onProgressNow = () => {};
  }
}

export async function synthesize(text, words, voice = DEFAULT_VOICE) {
  const spoken = speakable(text);
  const key = `${voice}|${spoken}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    if (!ready) await loadVoice();
    const { samples, sr } = await ask({ type: "speak", text: spoken, voice });
    const duration = samples.length / sr;
    const url = URL.createObjectURL(
      new Blob([encodeWav(samples, sr)], { type: "audio/wav" }),
    );
    return { url, duration, timings: estimateWordTimings(words, duration) };
  })();
  cache.set(key, job);
  try {
    return await job;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

/**
 * Gather what to synthesise in one go, starting at `startId`.
 *
 * Bigger packs read better and cost less overhead, but nothing is heard until
 * the whole pack is synthesised. `limit` lets the caller ask for a small first
 * mouthful so playback starts sooner, then go back to full-size packs while
 * the reader is already listening.
 */
export function packFrom(sentences, startId, limit) {
  const from = sentences.filter(s => s.id >= startId).slice(0, 16);
  const items = from.map(s => [s.id, s.kind || "body", s.text]);
  const ids = packForSpeech(items, limit);
  const picked = ids.map(id => sentences.find(s => s.id === id)).filter(Boolean);
  return {
    ids,
    text: picked.map(s => s.text).join(" "),
    words: picked.flatMap(s => s.words),
    parts: picked.map(s => ({ id: s.id, words: s.words.length })),
    through: ids.at(-1),
  };
}
