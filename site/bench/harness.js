/**
 * The measured half of the backend benchmark; bench.js drives it.
 *
 * Everything here runs on the page rather than in a worker: a worker would
 * hide load failures behind a message channel, and the number we want -- wall
 * clock around `generate` -- is the same either way.
 */
import { KokoroTTS } from "kokoro-js";
// kokoro-js depends on this package rather than bundling it, so the env we
// import here is the same object its sessions are built from.
import { env } from "@huggingface/transformers";

const log = m => { document.getElementById("log").textContent += `\n${m}`; };

/** Which adapter answered, so a WebGPU number can be believed or thrown out. */
async function adapterInfo() {
  try {
    if (!navigator.gpu) return { present: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { present: true, adapter: null };
    const info = adapter.info || (await adapter.requestAdapterInfo?.()) || {};
    return {
      present: true,
      vendor: info.vendor, architecture: info.architecture,
      device: info.device, description: info.description,
      isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter,
      maxBufferSize: adapter.limits?.maxBufferSize,
    };
  } catch (err) {
    return { present: !!navigator.gpu, error: String(err?.message || err) };
  }
}

/** Waveform facts that expose a collapsed or clipped clip without ears. */
function stats(samples, sr) {
  let sum = 0, peak = 0, clipped = 0, quiet = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    sum += v * v;
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    if (a < 1e-4) quiet++;
  }
  // Zero crossings stand in for a spectral centroid: brightness is what moves
  // when a quantised model turns speech into buzz or hiss.
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  }
  return {
    seconds: samples.length / sr,
    rms: Math.sqrt(sum / (samples.length || 1)),
    peak, clipped,
    silentFraction: quiet / (samples.length || 1),
    zcr: crossings / (samples.length || 1),
  };
}

/** A coarse loudness envelope the driver lines up against the q8 baseline. */
function envelope(samples, bins = 400) {
  const out = new Array(bins).fill(0);
  const per = Math.max(1, Math.floor(samples.length / bins));
  for (let b = 0; b < bins; b++) {
    let sum = 0, n = 0;
    for (let i = b * per; i < Math.min((b + 1) * per, samples.length); i++, n++) {
      sum += samples[i] * samples[i];
    }
    out[b] = n ? Math.sqrt(sum / n) : 0;
  }
  return out;
}

function audioOf(result) {
  const samples = result?.audio instanceof Float32Array ? result.audio
    : result?.audio?.audio instanceof Float32Array ? result.audio.audio
      : result instanceof Float32Array ? result : new Float32Array(0);
  const sr = result?.sampling_rate || result?.audio?.sampling_rate || 24000;
  return { samples, sr };
}

/**
 * Load one configuration and speak `texts`, returning per-pack timings.
 *
 * The first pack compiles kernels (WASM) or builds pipelines (WebGPU), so it
 * is reported separately and left out of the sustained ratio: what decides
 * whether 2x playback holds is the steady state, not the first second.
 */
async function run({ device, dtype, voice = "af_heart", texts, keepWave = false, threads }) {
  const bytes = new Map();
  // onnxruntime-web defaults to min(4, cores/2) threads, so a 12-core machine
  // runs inference on four of them. Worth knowing whether the other eight
  // would help before deciding how many workers to hand out.
  if (threads) env.backends.onnx.wasm.numThreads = threads;
  const t0 = performance.now();
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype, device,
    progress_callback: ev => {
      if (ev?.file && typeof ev.total === "number") bytes.set(ev.file, ev.total);
    },
  });
  const loadMs = performance.now() - t0;

  const packs = [];
  let wave = null;
  for (const text of texts) {
    const started = performance.now();
    const { samples, sr } = audioOf(await tts.generate(text, { voice }));
    packs.push({
      chars: text.length, ms: performance.now() - started,
      ...stats(samples, sr), env: envelope(samples),
    });
    if (keepWave && !wave) wave = { sr, samples: Array.from(samples) };
    log(`${device}/${dtype} pack ${packs.length}: ${Math.round(packs.at(-1).ms)}ms`);
  }
  const steady = packs.slice(1);
  const audioS = steady.reduce((a, p) => a + p.seconds, 0);
  const computeS = steady.reduce((a, p) => a + p.ms, 0) / 1000;
  return {
    device, dtype, loadMs,
    threads: env.backends.onnx.wasm.numThreads,
    downloadBytes: [...bytes.values()].reduce((a, b) => a + b, 0),
    files: Object.fromEntries(bytes),
    firstPackMs: packs[0].ms, firstPackSeconds: packs[0].seconds,
    realTimeRatio: audioS / computeS,
    packs: packs.map(({ env, ...rest }) => rest),
    envelopes: packs.map(p => p.env),
    wave,
  };
}

/**
 * The same measurement through the real worker, protocol and all.
 *
 * The numbers above come from calling kokoro-js directly, which is the right
 * way to compare backends but proves nothing about the app. This drives
 * src/lib/tts.worker.js exactly as tts.js does, so it also shows which
 * backend pickBackend actually chose on this machine and whether it fell
 * back.
 */
async function runWorker({ voice = "af_heart", texts }) {
  const worker = new Worker(new URL("../src/lib/tts.worker.js", import.meta.url), { type: "module" });
  const notes = [];
  let id = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      if (data.ev?.status === "backend") notes.push(data.ev);
      return;
    }
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  const ask = msg => new Promise((resolve, reject) => {
    const mine = ++id;
    pending.set(mine, d => (d.type === "error" ? reject(new Error(d.message)) : resolve(d)));
    worker.postMessage({ ...msg, id: mine });
  });

  const t0 = performance.now();
  const loaded = await ask({ type: "load" });
  const loadMs = performance.now() - t0;
  const packs = [];
  for (const text of texts) {
    const r = await ask({ type: "speak", text, voice });
    packs.push({ chars: text.length, ms: r.ms, ...stats(r.samples, r.sr) });
  }
  const steady = packs.slice(1);
  worker.terminate();
  return {
    backend: loaded.backend, threads: loaded.threads, notes, loadMs, packs,
    realTimeRatio: steady.reduce((a, p) => a + p.seconds, 0)
      / (steady.reduce((a, p) => a + p.ms, 0) / 1000),
  };
}

window.__bench = {
  run,
  runWorker,
  adapterInfo,
  caps: {
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    userAgent: navigator.userAgent,
  },
};
log("ready");
