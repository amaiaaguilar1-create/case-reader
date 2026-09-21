/**
 * What the worker is given, and in what order.
 *
 * The worker does one inference at a time and cannot be interrupted, so
 * everything that matters happens before a request is sent: work the reader is
 * waiting for goes first, and a guess about a document they have turned away
 * from is thrown out rather than made.
 */
import { beforeEach, expect, test, vi } from "vitest";

/** Stands in for the Web Worker: records what it is asked, answers on demand. */
class FakeWorker {
  constructor() {
    this.asked = [];
    FakeWorker.last = this;
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
  spoken() { return this.asked.filter(m => m.type === "speak").map(m => m.text); }
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let tts;

beforeEach(async () => {
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
