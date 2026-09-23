/**
 * What the workers are given, and in what order.
 *
 * Each worker does one inference at a time and cannot be interrupted, so
 * everything that matters happens before a request is sent: work the reader is
 * waiting for goes first, a guess about a document they have turned away from
 * is thrown out rather than made, and with several workers a guess never takes
 * the last free one.
 */
import { beforeEach, expect, test, vi } from "vitest";

/** How many workers the backend asks for; a test sets it before it grows. */
let workers = 1;
vi.mock("../src/lib/backend.js", () => ({
  pickBackend: () => "wasm",
  workerBudget: () => workers,
}));

/** Stands in for the Web Worker: records what it is asked, answers on demand. */
class FakeWorker {
  constructor() {
    this.asked = [];
    FakeWorker.last = this;
    FakeWorker.all.push(this);
  }
  postMessage(msg) { this.asked.push(msg); }
  /** Answer the oldest unanswered request. */
  reply(samples = 1200) {
    const msg = this.asked.find(m => !m.answered);
    msg.answered = true;
    if (msg.type === "load") this.onmessage({ data: { type: "loaded", id: msg.id, threads: true } });
    else {
      this.onmessage({
        data: { type: "audio", id: msg.id, samples: new Float32Array(samples), sr: 24000, ms: 100 },
      });
    }
    return msg;
  }
  busy() { return this.asked.some(m => m.type === "speak" && !m.answered); }
  spoken() { return this.asked.filter(m => m.type === "speak").map(m => m.text); }
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let tts;

/** Every worker with a pack in it right now. */
const working = () => FakeWorker.all.filter(w => w.busy());

/**
 * Bring the pool up to its full size.
 *
 * A worker joins by loading the model and saying a throwaway phrase, and they
 * come up one at a time, so answering in that order is what grows the pool.
 */
async function fillPool() {
  for (let i = 1; i < workers; i++) {
    FakeWorker.all[i].reply();          // the model
    await settle();
    FakeWorker.all[i].reply();          // the warm-up phrase
    await settle();
  }
}

beforeEach(async () => {
  workers = 1;
  FakeWorker.all = [];
  globalThis.Worker = FakeWorker;
  globalThis.URL.createObjectURL = () => "blob:clip";
  globalThis.Blob = class {};
  vi.resetModules();
  tts = await import("../src/lib/tts.js");
  const load = tts.loadVoice();
  await settle();
  FakeWorker.last.reply();
  await load;
  await settle();
});

test("what the reader is waiting for goes before what we are guessing", async () => {
  const worker = FakeWorker.last;
  // The first request goes straight through: the worker was idle.
  const busy = tts.synthesize("first up", [], "af_heart", { priority: tts.SOON, tag: "a" });
  await settle();
  expect(worker.spoken()).toEqual(["first up"]);

  tts.synthesize("a guess", [], "af_heart", { priority: tts.SOON, tag: "a" }).catch(() => {});
  tts.synthesize("another guess", [], "af_heart", { priority: tts.SOON, tag: "a" }).catch(() => {});
  const wanted = tts.synthesize("what they asked for", [], "af_heart", { tag: "b" });
  await settle();
  expect(worker.spoken()).toEqual(["first up"]);   // nothing else sent yet

  worker.reply();
  await busy;
  await settle();
  expect(worker.spoken().at(-1)).toBe("what they asked for");
  worker.reply();
  await wanted;
});

test("a guess about another document is dropped, not made", async () => {
  const worker = FakeWorker.last;
  const busy = tts.synthesize("in the worker", [], "af_heart", { priority: tts.SOON, tag: "a" });
  await settle();
  const stale = tts.synthesize("stale guess", [], "af_heart", { priority: tts.SOON, tag: "a" });
  const keep = tts.synthesize("still wanted", [], "af_heart", { priority: tts.SOON, tag: "b" });
  await settle();

  tts.dropGuesses("b");
  await expect(stale).rejects.toThrow();
  worker.reply();                                   // the in-flight one finishes
  await busy;
  await settle();
  expect(worker.spoken()).toEqual(["in the worker", "still wanted"]);
  worker.reply();
  await keep;
});

test("a guess the reader starts waiting for moves up the queue", async () => {
  const worker = FakeWorker.last;
  const busy = tts.synthesize("in the worker", [], "af_heart", { tag: "a" });
  await settle();
  const guessed = tts.synthesize("guessed at", [], "af_heart", { priority: tts.SOON, tag: "a" });
  tts.synthesize("asked for later", [], "af_heart", { tag: "a" }).catch(() => {});
  await settle();

  tts.raise("guessed at", "af_heart");              // they pressed play on it
  worker.reply();
  await busy;
  await settle();
  expect(worker.spoken().at(-1)).toBe("guessed at");
  worker.reply();
  await guessed;
});

/** Grow the pool: one pack through the first worker is what starts it. */
async function startPool() {
  const first = tts.synthesize("the first pack", [], "af_heart", { tag: "a" });
  await settle();
  FakeWorker.all[0].reply();
  await first;
  await settle();
  await fillPool();
}

test("a pool makes several packs at once, and the rest wait their turn", async () => {
  workers = 3;
  await startPool();
  expect(FakeWorker.all).toHaveLength(3);

  const packs = ["two", "three", "four", "five"]
    .map(t => tts.synthesize(t, [], "af_heart", { tag: "a" }));
  await settle();
  // Three in flight, one held back: the pool is the whole of the limit.
  expect(working()).toHaveLength(3);
  expect(FakeWorker.all.flatMap(w => w.spoken()).filter(t => t === "five")).toHaveLength(0);

  // They come back in whatever order they finish -- the last one first here.
  FakeWorker.all[2].reply();
  await settle();
  expect(FakeWorker.all[2].spoken().at(-1)).toBe("five");
  for (const w of FakeWorker.all) while (w.busy()) { w.reply(); await settle(); }
  const made = await Promise.all(packs);
  expect(made).toHaveLength(4);
});

test("a guess never takes the last free worker", async () => {
  workers = 3;
  await startPool();
  const guesses = ["a guess", "another guess", "a third guess"]
    .map(t => tts.synthesize(t, [], "af_heart", { priority: tts.SOON, tag: "a" }).catch(() => {}));
  await settle();
  expect(working()).toHaveLength(2);          // one worker held in reserve

  // So the words someone is waiting for start now, not in ten seconds' time.
  const wanted = tts.synthesize("what they asked for", [], "af_heart", { tag: "b" });
  await settle();
  expect(working()).toHaveLength(3);
  const free = FakeWorker.all.find(w => w.spoken().at(-1) === "what they asked for");
  expect(free).toBeTruthy();
  free.reply();
  await wanted;
  for (const w of FakeWorker.all) while (w.busy()) { w.reply(); await settle(); }
  await Promise.all(guesses);
});

/**
 * A backend that answers nothing at all.
 *
 * WebKit hands out a WebGPU adapter and can then stall inside inference: no
 * audio, no error, nothing to catch. The only signal is the clock, so the
 * page gives up on the worker, throws it away, and builds the replacement on
 * the configuration that cannot hang.
 */
test("a worker that stops answering is replaced by one that cannot hang", async () => {
  tts.deadlines.first = 40;                       // real time; the wait is the point
  const stuck = FakeWorker.last;
  const failed = tts.synthesize("into the void", [], "af_heart", { tag: "a" })
    .then(() => null, e => e);
  await settle();
  expect(stuck.spoken()).toEqual(["into the void"]);   // it was sent

  const err = await failed;                       // ...and never answered
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toMatch(/stopped responding/);

  // The next attempt builds a new worker and tells it not to probe again.
  tts.synthesize("second try", [], "af_heart", { tag: "a" }).catch(() => {});
  await settle();
  const replacement = FakeWorker.all.at(-1);
  expect(replacement).not.toBe(stuck);
  expect(replacement.asked.find(m => m.type === "load")?.force).toBe(true);
});
