/**
 * Which inference backend this device should use, and how many of them.
 *
 * Measured on a 12-core Mac (Chromium 153, Apple metal-3 adapter, one
 * session, see bench/bench.js) as seconds of audio produced per second of
 * compute:
 *
 *     webgpu / fp32    9.6x    326MB    matches the fp32 CPU waveform
 *     webgpu / q4      9.6x    305MB    dulled: 8% less brightness
 *     wasm   / fp32    2.7x    326MB    reference
 *     wasm   / uint8   2.0x    177MB    indistinguishable from fp32 here
 *     wasm   / q8      1.2x     92MB    today's default
 *     webgpu / q8      1.2x     92MB    slower AND 8% longer clips
 *     webgpu / fp16   10.1x    163MB    BROKEN: speaks 2s, then silence
 *     webgpu / q4f16  10.1x    155MB    BROKEN: same collapse
 *     webgpu / uint8     --    177MB    BROKEN: 91s of NaN for one sentence
 *
 * Those are from a bare page. Inside tts.worker.js, where the app actually
 * runs, the CPU numbers are a third lower again -- wasm/fp32 measures 1.58x
 * and wasm/q8 0.90x -- while webgpu/fp32 holds at 10.0x. The GPU does not
 * care which thread asked it.
 *
 * Three things fall out of that, and they are why this file reads the way it
 * does:
 *
 * - Playback at 2x needs 2x real time sustained. WebGPU clears it five times
 *   over. Nothing on the CPU clears it in one worker, at any precision or
 *   thread count, on a machine larger than most readers have -- the CPU path
 *   only reaches 2x by running two or three workers at once, which is what
 *   workerBudget is for.
 * - Nothing small is fast. The 92MB model is the slowest thing measured; the
 *   fast models are 326MB. There is no third option: every float16 variant,
 *   which is where the middle of the size range lives, is broken on this
 *   runtime. So speed is bought with download, and that is a decision about
 *   the reader's data, not about the machine.
 * - fp32 is the only precision that is fast and known-good on both devices.
 *   The README already records int8 collapsing to near-silence in the Python
 *   engine; the f16 exports do the same thing here, and webgpu/uint8 returns
 *   NaN. Low precision stays off the default path.
 */

/** Today's configuration: small, slow, and never wrong. */
export const VOICE_PREF_KEY = "caseReader.voiceSize";

const SAFE = { device: "wasm", dtype: "q8" };

/** The 326MB model. Only worth asking someone to fetch over a fat pipe. */
const BIG_MB = 326;

/**
 * Does this look like a connection where a 326MB download is rude?
 *
 * navigator.connection is Chromium-only and its numbers are estimates, so the
 * test is deliberately one-sided: a connection is metered only when the
 * browser says so outright. Absent evidence we assume wifi, because the
 * alternative -- assuming every unknown connection is a phone on 3G -- would
 * hand the slow model to every Safari and Firefox user on a desk.
 */
function metered(nav) {
  const c = nav.connection;
  if (!c) return false;
  if (c.saveData === true) return true;
  return c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g";
}

/**
 * Is there a GPU we can actually run on?
 *
 * `navigator.gpu` existing is not enough. A headless or virtualised browser
 * answers with a software adapter, which runs the shaders on the same cores
 * WASM would have used and is slower than WASM for the trouble --
 * `isFallbackAdapter` is how it admits that. Asking for the device as well
 * catches the case where the adapter exists but cannot be opened.
 */
async function gpu(nav) {
  if (!nav.gpu?.requestAdapter) return null;
  const adapter = await nav.gpu.requestAdapter();
  if (!adapter || adapter.isFallbackAdapter) return null;
  // Weights live in one buffer per tensor; a limit this small means the fp32
  // model will not fit and the session would fail on load rather than here.
  if (adapter.limits?.maxBufferSize && adapter.limits.maxBufferSize < 256e6) return null;
  const device = await adapter.requestDevice?.();
  if (!device) return null;
  // Nothing else needs the device: the real one is created inside
  // onnxruntime, and holding this one open would keep a second copy of every
  // driver allocation alive for the life of the tab.
  device.destroy?.();
  const info = adapter.info || {};
  return { vendor: info.vendor || "unknown", architecture: info.architecture || "" };
}

/**
 * Pick a device and precision for this machine.
 *
 * Returns `{ device, dtype, why }`; `why` is what to print in a log line or a
 * bug report when synthesis turns out to be slower than someone expected.
 * Every failure path lands on {wasm, q8}, which is what the site shipped
 * before this file existed.
 */
const VALID = new Set(["big", "small"]);

/**
 * What the reader picked on the "save the voice" screen, if anything.
 *
 * Synchronous, and only meaningful on the main thread -- a worker has no
 * localStorage at all, which is where pickBackend actually runs. Use
 * storedPreference() for the answer that works in both places.
 */
export function voicePreference() {
  try {
    const v = localStorage.getItem(VOICE_PREF_KEY);
    return VALID.has(v) ? v : null;
  } catch {
    return null;
  }
}

/** The choice, readable from a worker too. IndexedDB is the part they share. */
export async function storedPreference() {
  const local = voicePreference();
  if (local) return local;
  try {
    const { metaGet } = await import("./db.js");
    const v = await metaGet(VOICE_PREF_KEY);
    return VALID.has(v) ? v : null;
  } catch {
    return null;
  }
}

/** Written to both stores, because only one of them reaches the worker. */
export async function setVoicePreference(choice) {
  try {
    localStorage.setItem(VOICE_PREF_KEY, choice);
  } catch {
    /* Private browsing. IndexedDB below is the one that matters anyway. */
  }
  try {
    const { metaSet } = await import("./db.js");
    await metaSet(VOICE_PREF_KEY, choice);
  } catch {
    /* They will be asked again on the next device. Not worth failing over. */
  }
}

export async function pickBackend(nav = navigator, isolated = globalThis.crossOriginIsolated) {
  try {
    const cores = nav.hardwareConcurrency || 1;
    const memory = nav.deviceMemory || 0;
    // An explicit choice outranks every guess about the machine. Someone who
    // asked for the small model on a fast laptop has a reason -- a data cap
    // the browser cannot see -- and someone who asked for the big one on a
    // phone has already been shown what it costs.
    const chosen = await storedPreference();
    if (chosen === "small") {
      return { ...SAFE, why: "you chose the smaller download" };
    }
    const thrifty = chosen === "big" ? false : metered(nav);
    // deviceMemory is Chromium-only, so silence is not smallness: Firefox on
    // a 16-core desktop reports nothing at all. Only a number we were given
    // and do not like counts against the machine.
    const roomy = !memory || memory >= 8;

    if (thrifty) {
      // A 326MB model over a metered connection costs more than the stutter
      // it prevents, and the reader cannot hear the difference between a
      // download that never finishes and no voice at all.
      return { ...SAFE, why: "connection looks metered; keeping the 92MB model" };
    }

    // Known-small memory rules out the big model on either device: the
    // download alone is a tenth of what such a machine has.
    if (chosen !== "big" && memory && memory < 4) {
      return { ...SAFE, why: `${memory}GB of memory; keeping the 92MB model` };
    }

    const adapter = await gpu(nav);
    if (adapter) {
      return {
        device: "webgpu",
        dtype: "fp32",
        why: `WebGPU on ${adapter.vendor}${adapter.architecture ? ` ${adapter.architecture}` : ""}`
          + `; fp32 measured at 10x real time for a ${BIG_MB}MB download`,
      };
    }

    // No GPU, so this is onnxruntime's WASM backend on the CPU. fp32 is
    // faster there than the quantised models -- the int8 kernels cost more in
    // dequantisation than they save -- but it needs the cores to run the
    // threads on and the memory to hold 326MB of weights.
    if (isolated && (chosen === "big" || (cores >= 8 && roomy))) {
      return {
        device: "wasm",
        dtype: "fp32",
        why: `no usable WebGPU; ${cores} cores run fp32 on the CPU at ~1.6x real`
          + ` time per worker, for a ${BIG_MB}MB download`,
      };
    }
    if (!isolated) {
      // Without COOP/COEP onnxruntime runs on a single thread, where fp32
      // measured 0.64x real time: the big download would buy a slower voice.
      return { ...SAFE, why: "not cross-origin isolated, so inference is single-threaded" };
    }
    return { ...SAFE, why: `only ${cores} cores / ${memory || "unknown "}GB; keeping the 92MB model` };
  } catch (err) {
    // A probe throwing is not a reason to have no voice.
    return { ...SAFE, why: `capability probe failed (${err?.message || err})` };
  }
}

/**
 * How many synthesis workers this backend should be given.
 *
 * WebGPU gets one. There is a single queue in the driver whichever way the
 * work arrives, so a second worker would add a second 326MB copy of the
 * weights and a second compile, and win nothing.
 *
 * WASM gets more than one, because onnxruntime's own thread pool stops
 * scaling around six threads and the cores past that are only reachable by
 * running a second session on them. How many more depends on the model, which
 * is the one place the dtype has to leak into this decision. Measured on 12
 * cores, as aggregate real time across all the sessions:
 *
 *              1 worker   2 workers   3 workers
 *     fp32       2.13x      2.96x       1.48x
 *     q8         1.20x      1.77x       2.51x
 *
 * fp32 peaks at two and then falls off a cliff: three copies of 326MB of
 * weights no longer fit anywhere useful and the machine spends its time
 * moving them. q8's weights are small enough that a third session still has
 * somewhere to live, which is the only way the 92MB model reaches 2x at all.
 */
export function workerBudget(backend, nav = navigator) {
  if (backend?.device === "webgpu") return 1;
  const cores = nav.hardwareConcurrency || 1;
  const memory = nav.deviceMemory || 0;
  if (backend?.dtype === "fp32") {
    // Each fp32 session holds ~330MB of weights. Two of those on a 4GB phone
    // is how a tab gets killed mid-sentence.
    if (memory && memory < 8) return 1;
    return cores >= 12 ? 2 : 1;
  }
  if (cores >= 12) return 3;
  return cores >= 8 ? 2 : 1;
}

/**
 * How many threads one WASM session should ask onnxruntime for.
 *
 * onnxruntime-web defaults to `min(4, cores/2)`, which leaves eight of twelve
 * cores idle. Measured on 12 cores, one session alone:
 *
 *     threads      1      2      4      6      8     12
 *     fp32      0.64x  1.27x  2.14x  2.66x  2.45x  2.39x
 *     q8        0.49x  0.70x  0.90x  1.04x  1.06x  1.21x
 *
 * Six is where fp32 stops paying, and a session's share of the machine is
 * rarely more than that anyway once workerBudget has divided it up.
 */
export function wasmThreads(backend, nav = navigator) {
  const cores = nav.hardwareConcurrency || 1;
  return Math.max(1, Math.min(6, Math.floor(cores / workerBudget(backend, nav))));
}
