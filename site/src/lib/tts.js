import { pickBackend, workerBudget } from "./backend.js";
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

/** What a request is worth. Lower speaks first. */
export const NOW = 0;        // the reader is waiting for this
export const SOON = 1;       // a guess: a document that is open but silent
const HOUSEKEEPING = 2;      // warm-up, nobody is waiting

const cache = new Map();
let ready = false;
let onProgressNow = () => {};
let seq = 0;

/**
 * The pool.
 *
 * One worker synthesises at about 0.93x real time, so 2x playback outruns it
 * by a second per second and no amount of banking ahead can cover a deficit
 * that grows. Packs are independent -- each is its own text-to-audio call --
 * so several can be made at once. They do not scale linearly, because ONNX
 * already runs several WASM threads inside each worker and they share the same
 * cores: measured on a 12-core M2 Max, one to four workers made 1.02x, 1.94x,
 * 2.83x and 2.94x real time, so the third worker is the last one worth having
 * and each costs another copy of the model in memory. How many to run is the
 * backend's call, since it depends on where inference happens.
 */
const pool = [];
let chosen = null;
let probing = null;

/**
 * Ask the backend how many workers it wants.
 *
 * pickBackend is async -- it has to ask for a WebGPU adapter, and on the CPU
 * path it reads the reader's download choice out of IndexedDB. So the answer
 * is not available at the moment the first pack is requested. Start at one
 * worker, which is what we would build anyway (the pool grows behind the
 * first completed pack, since loading a second copy of the model wants the
 * cores the first pack is using), and widen once the probe lands.
 */
function resolveBudget() {
  if (probing) return probing;
  probing = Promise.resolve()
    .then(() => pickBackend())
    .then(backend => {
      chosen = backend;
      // The probe can land after the pack that would have widened the pool has
      // already finished, and grow() only retries on the next one. Retry here
      // so the pool cannot be left at one worker by timing alone.
      if (lastVoice) grow(lastVoice);
      pump();
    })
    .catch(() => { chosen = chosen || {}; });
  return probing;
}

/**
 * How many workers to run.
 *
 * The backend is cached, the count is not: workerBudget is a pure function of
 * the backend, so deriving it on each call costs nothing and cannot go stale.
 * Until the probe lands this is one, which is what we would build anyway --
 * the pool grows behind the first completed pack, because loading a second
 * copy of the model wants the cores the first pack is using.
 */
function poolSize() {
  if (!chosen) {
    resolveBudget();
    return 1;
  }
  return Math.max(1, Math.min(8, Math.round(workerBudget(chosen)) || 1));
}

/** The worker in slot `i`, started if it is not running yet. */
function slot(i) {
  if (pool[i]) return pool[i];
  const s = {
    worker: new Worker(new URL("./tts.worker.js", import.meta.url), { type: "module" }),
    busy: false, guess: false, loaded: false, pending: new Map(),
  };
  s.worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      report(data.ev);
      return;
    }
    const waiting = s.pending.get(data.id);
    if (!waiting) return;
    s.pending.delete(data.id);
    if (data.type === "error") waiting.reject(new Error(data.message));
    else waiting.resolve(data);
  };
  s.worker.onerror = e => {
    const err = new Error(e.message || "The voice stopped unexpectedly.");
    for (const waiting of s.pending.values()) waiting.reject(err);
    s.pending.clear();
    // Retire this one and read on with the rest: a worker that dies partway
    // through a pack should cost that pack, not the whole voice.
    pool[i] = null;
    s.worker.terminate?.();
    if (i === 0) ready = false;
    pump();
  };
  pool[i] = s;
  return s;
}

function ask(s, message, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject });
    s.worker.postMessage({ ...message, id }, transfer);
  });
}

/**
 * The queue of work waiting for a worker.
 *
 * Inference cannot be interrupted once it has started and each worker takes
 * one request at a time, so arrival order is the only order they know. That
 * made a guess about a document nobody has opened sit in front of the words
 * someone is waiting for. Here a job can still be reordered or thrown away,
 * which is everything we can usefully control.
 */
const queue = [];

function enqueue(job) {
  queue.push(job);
  pump();
}

/**
 * Hand queued work to whatever workers are free.
 *
 * Lowest priority number first and arrival order within a priority: packs are
 * asked for in the order they will be heard, so among equals first-in is the
 * order that keeps the queue moving forwards.
 *
 * Whenever there are two or more workers, one is kept off speculative work.
 * A guess runs a full pack -- ten seconds or so -- and cannot be recalled, so
 * a pool with every worker guessing would make the reader wait that long for
 * a place we guessed wrong about. With one worker there is nothing to hold
 * back and the rule does not bite.
 */
function pump() {
  for (;;) {
    const free = pool.find(s => s && s.loaded && !s.busy);
    if (!free || !queue.length) return;
    const room = Math.max(1, pool.filter(s => s?.loaded).length - 1)
      - pool.filter(s => s?.busy && s.guess).length;
    let at = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].priority > NOW && room <= 0) continue;
      if (at < 0 || queue[i].priority < queue[at].priority) at = i;
    }
    if (at < 0) return;
    run(free, queue.splice(at, 1)[0]);
  }
}

let lastVoice = null;
function run(s, job) {
  lastVoice = job.voice;
  s.busy = true;
  s.guess = job.priority > NOW;
  job.started = true;
  ask(s, { type: "speak", text: job.text, voice: job.voice })
    .then(job.resolve, job.reject)
    .finally(() => {
      s.busy = false;
      s.guess = false;
      grow(job.voice);
      pump();
    });
}

/**
 * Bring the rest of the pool up, one worker at a time, behind the first pack.
 *
 * Each worker loads its own copy of the model and compiles its own WASM
 * kernels: seconds of work, and all of it wants the cores the first pack is
 * using. Growing behind that pack -- and never two workers at once -- keeps
 * time-to-first-word where it was while the pool fills in for everything after
 * it.
 */
let live = 1;
let growing = false;
async function grow(voice) {
  if (growing || live >= poolSize()) return;
  growing = true;
  try {
    while (live < poolSize()) {
      const i = live++;
      const s = slot(i);
      try {
        await ask(s, { type: "load" });
        s.loaded = true;
        await warm(s, voice);
      } catch {
        pool[i] = null;
        return;
      }
    }
  } finally {
    growing = false;
  }
}

/** Compile a fresh worker's kernels on a throwaway phrase before real work
 *  lands on it; see `warmUp`. Marked busy from the start so `pump` cannot
 *  hand it a pack that would then queue behind this. */
function warm(s, voice) {
  s.busy = true;
  return ask(s, { type: "speak", text: "Ready.", voice })
    .catch(() => {})
    .finally(() => { s.busy = false; pump(); });
}

/**
 * Forget queued guesses that are not about `tag`.
 *
 * Called when the reader turns to another document: whatever was being
 * guessed for the old one must not delay the new one. A job already inside
 * the worker cannot be recalled, which is the other reason to keep guesses
 * small.
 */
export function dropGuesses(tag) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job.priority === NOW || job.tag === tag) continue;
    queue.splice(i, 1);
    cache.delete(job.key);
    job.reject(new Error("Superseded."));
  }
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

/**
 * Say something short that nobody hears.
 *
 * The first inference of a session compiles the WASM kernels: measured at
 * about 0.45s here (the first pack ran at 0.96x real time against 0.93x for
 * every pack after it). Spending it on a throwaway phrase while nothing else
 * is waiting keeps it off the first pack the reader is waiting for.
 */
function warmUp(voice) {
  return new Promise((resolve, reject) => {
    enqueue({
      text: "Ready.", voice, key: `warm|${voice}`, tag: "warm",
      priority: HOUSEKEEPING, started: false, resolve, reject,
    });
  });
}

let loading = null;
export async function loadVoice(onProgress = () => {}, voice = DEFAULT_VOICE) {
  onProgressNow = onProgress;
  if (ready) {
    onProgress(1);
    return;
  }
  if (!loading) {
    // Probe alongside the download rather than after it: the pool checks its
    // size the moment the first pack lands, and a backend that is still
    // unknown then reads as "one worker is enough".
    //
    // Deliberately a fresh probe. Anything that touched the pool earlier
    // probed before the reader chose their download size, and the two models
    // want different numbers of workers -- three for the 92MB one, two for
    // the 326MB one. This is the first moment that choice is final.
    probing = null;
    const probe = resolveBudget();
    loading = ask(slot(0), { type: "load" })
      .then(async done => { await probe; return done; })
      .finally(() => { loading = null; });
  }
  try {
    const done = await loading;
    if (pool[0]) pool[0].loaded = true;
    ready = true;
    if (!done.threads) {
      // Without cross-origin isolation ONNX runs on one core. The service
      // worker in index.html supplies the headers a static host cannot.
      console.info("Case Reader: voice is running single-threaded.");
    }
    onProgress(1);
    pump();
    // Only warm when nothing is waiting: if a pack is already queued, that
    // pack is what the worker should be doing.
    setTimeout(() => {
      if (!queue.length && !pool.some(s => s?.busy)) warmUp(voice).catch(() => {});
    }, 50);
  } finally {
    onProgressNow = () => {};
  }
}

/**
 * Speak `text`.
 *
 * `priority` decides what the worker picks up next, and `tag` (the document
 * this belongs to) says whose guesses to throw away when the reader moves on.
 * A clip already asked for speculatively is promoted rather than re-made, so
 * pressing play on something we guessed right about costs nothing.
 */
export async function synthesize(text, words, voice = DEFAULT_VOICE, opts = {}) {
  const spoken = speakable(text);
  const key = `${voice}|${spoken}`;
  const hit = cache.get(key);
  if (hit) {
    hit.raise(opts.priority ?? NOW);
    return hit.clip;
  }
  const job = {
    text: spoken, voice, key, tag: opts.tag,
    priority: opts.priority ?? NOW, started: false,
  };
  const clip = (async () => {
    if (!ready) await loadVoice(undefined, voice);
    const { samples, sr, ms } = await new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      enqueue(job);
    });
    const duration = samples.length / sr;
    const url = URL.createObjectURL(
      new Blob([encodeWav(samples, sr)], { type: "audio/wav" }),
    );
    return { url, duration, ms, timings: estimateWordTimings(words, duration) };
  })();
  cache.set(key, {
    clip,
    raise(priority) { if (!job.started) job.priority = Math.min(job.priority, priority); },
  });
  try {
    return await clip;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

/** Move work already asked for up the queue: someone is now waiting on it. */
export function raise(text, voice = DEFAULT_VOICE, priority = NOW) {
  cache.get(`${voice}|${speakable(text)}`)?.raise(priority);
}

const CLAUSE_END = /[,;:—–]["')\]]?$/;
const MIN_WORDS = 5;

/**
 * Where to stop speaking this sentence, as a word index one past the last.
 *
 * A single sentence can run fifteen seconds, and nothing is heard until all of
 * it is made -- which is most of the wait before the first word. So when the
 * budget is smaller than what is left, stop at the last clause break that
 * fits, where a person would draw breath, and fall back to a plain word break
 * only when no comma or dash is within reach.
 */
function cutAt(sent, fromWord, limit) {
  const words = sent.words;
  const base = words[fromWord]?.start ?? 0;
  if (sent.text.length - base <= limit) return words.length;
  let fits = Math.min(fromWord + MIN_WORDS, words.length);
  let clause = 0;
  for (let i = fromWord; i < words.length; i++) {
    if (words[i].end - base > limit && i - fromWord >= MIN_WORDS) break;
    fits = i + 1;
    if (fits - fromWord >= MIN_WORDS && CLAUSE_END.test(words[i].text)) clause = fits;
  }
  const end = clause || fits;
  if (words.length - end >= MIN_WORDS) return end;
  // What is left would be a scrap, and a three-word pack sounds like a
  // stumble. Stop earlier instead -- never later, which would cost more time
  // than the pack was given.
  return Math.min(words.length, Math.max(fromWord + MIN_WORDS, words.length - MIN_WORDS));
}

/**
 * Gather what to synthesise in one go, starting at word `fromWord` of
 * `startId`.
 *
 * Bigger packs read better and cost less overhead, but nothing is heard until
 * the whole pack is synthesised. `limit` lets the caller ask for a small first
 * mouthful -- part of a sentence, if the sentence is long -- so playback
 * starts sooner, then grow packs back to full size while the reader is already
 * listening. `thruWord` is where to pick up: 0 means the sentence is finished.
 */
export function packFrom(sentences, startId, limit, fromWord = 0) {
  const head = sentences.find(s => s.id === startId);
  if (!head) return { ids: [], text: "", words: [], parts: [], through: startId, thruWord: 0 };
  const end = cutAt(head, fromWord, limit);
  if (end < head.words.length) {
    const words = head.words.slice(fromWord, end);
    return {
      ids: [head.id],
      text: head.text.slice(words[0].start, words.at(-1).end),
      words,
      parts: [{ id: head.id, from: fromWord, words: words.length }],
      through: head.id,
      thruWord: end,
    };
  }
  // The rest of this sentence fits; see how many whole ones follow it.
  const rest = head.text.slice(head.words[fromWord]?.start ?? 0);
  const after = sentences.filter(s => s.id > startId).slice(0, 15);
  const items = [[head.id, head.kind || "body", rest],
    ...after.map(s => [s.id, s.kind || "body", s.text])];
  const ids = packForSpeech(items, limit);
  const picked = ids.slice(1).map(id => sentences.find(s => s.id === id)).filter(Boolean);
  return {
    ids,
    text: [rest, ...picked.map(s => s.text)].join(" "),
    words: [...head.words.slice(fromWord), ...picked.flatMap(s => s.words)],
    parts: [
      { id: head.id, from: fromWord, words: head.words.length - fromWord },
      ...picked.map(s => ({ id: s.id, from: 0, words: s.words.length })),
    ],
    through: ids.at(-1),
    thruWord: 0,
  };
}
