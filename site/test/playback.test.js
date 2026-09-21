// @vitest-environment jsdom
/**
 * The window where two documents could speak at once.
 *
 * Synthesis takes seconds, so a play request spends most of its life waiting.
 * Anything the reader does in that time -- opening another document and
 * pressing play there -- starts a second request, and the two come back in
 * whatever order the speech is ready in. Here the second document is one that
 * has been heard before, so its audio is already in hand and it answers at
 * once, while the first is still being made: exactly the order that used to
 * leave both of them reading aloud.
 *
 * The clock is under our control, not the machine's: nothing is timed, every
 * clip is released by hand.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildDocument } from "../src/lib/chunker.js";

// The page itself, so the test drives the real buttons.
const HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const BODY = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "");

const say = who => [
  `${who} one begins the reading, and then ${who} two carries on.`,
  `${who} three follows after that, at a comfortable pace.`,
  `${who} four keeps going, because a document worth hearing is long.`,
  `${who} five brings the passage to a close, quietly.`,
].join(" ");
const DOCS = [buildDocument("Alpha", say("Alpha")), buildDocument("Beta", say("Beta"))];
DOCS.forEach((d, i) => { d.id = i + 1; });

/** Every clip made, newest last, each one released by the test. */
let clips = [];
/** Every Audio element the page built, in the order it built them. */
let sounds = [];

vi.mock("../src/lib/db.js", () => ({
  listDocs: async () => DOCS,
  getDoc: async id => DOCS.find(d => d.id === id),
  saveDoc: async d => d,
  deleteDoc: async () => {},
  metaGet: async key => key === "onboarded" || key === "voiceSaved",
  metaSet: async () => {},
  savePosition: async () => {},
}));
vi.mock("../src/lib/parse.js", () => ({
  parseFile: async () => { throw new Error("not used"); },
  parseText: () => { throw new Error("not used"); },
  SAMPLE: { title: "", text: "" },
}));
vi.mock("../src/lib/gate.js", () => ({
  unlocked: () => true, verify: async () => true, remember: () => {}, forget: () => {},
}));
vi.mock("../src/lib/tts.js", async () => {
  const real = await vi.importActual("../src/lib/tts.js");
  return {
    ...real,
    voiceReady: () => true,
    loadVoice: async () => {},
    dropGuesses: () => {},
    raise: () => {},
    // Hand back a promise the test decides when to settle, so two requests can
    // be in flight at once and finish in either order.
    synthesize: (text, words) => {
      const clip = {
        text,
        url: `blob:${clips.length}`,
        duration: 2,
        ms: 1900,
        timings: words.map((_, i) => [i, i + 1]),
      };
      let release;
      const promise = new Promise(res => { release = () => res(clip); });
      clips.push({ text, release, promise });
      return promise;
    },
  };
});

class FakeAudio {
  constructor(url) {
    this.src = url;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 2;
    this.playbackRate = 1;
    this.plays = 0;
    sounds.push(this);
  }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
}

const $ = id => document.getElementById(id);
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
/** Release the pack whose text starts with `word` and let the page react. */
async function release(word) {
  const clip = clips.find(c => !c.done && c.text.toLowerCase().startsWith(word));
  expect(clip, `no pack starting "${word}" was asked for`).toBeTruthy();
  clip.done = true;
  clip.release();
  await settle();
  return clip;
}
/** Hand back the oldest pack still being made. */
async function releaseNext() {
  const clip = clips.find(c => !c.done);
  expect(clip, "nothing was being made").toBeTruthy();
  clip.done = true;
  clip.release();
  await settle();
  return clip;
}
const playing = () => sounds.filter(a => !a.paused);

beforeEach(async () => {
  clips = [];
  sounds = [];
  document.body.innerHTML = BODY;
  document.documentElement.dataset.first = "";
  globalThis.Audio = FakeAudio;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  Element.prototype.scrollIntoView = () => {};
  vi.resetModules();
  await import("../src/main.js");
  await settle();
  DOCS.forEach(d => { d.position = 0; });
});

afterEach(() => { vi.resetModules(); });

/** Open a document from the library and press play, without waiting for it. */
async function open(title) {
  const item = [...document.querySelectorAll(".lib-item")]
    .find(b => b.querySelector(".t").textContent === title);
  item.click();
  await settle();
}

test("a superseded document does not speak over the one being read", async () => {
  await open("Alpha");
  $("play").click();
  await settle();
  expect(clips.some(c => c.text.toLowerCase().startsWith("alpha"))).toBe(true);
  expect(playing()).toHaveLength(0);          // still being made

  // The reader gives up and opens the other document, which has been heard
  // before: its audio is in hand and comes back at once.
  await open("Beta");
  $("play").click();
  await settle();
  await release("beta");
  expect(playing()).toHaveLength(1);
  const beta = playing()[0];

  // Now the abandoned request finishes. It must not start speaking.
  await release("alpha");
  expect(playing()).toEqual([beta]);
  expect($("docTitle").textContent).toBe("Beta");
});

test("pressing play in a new document does not resume the old one", async () => {
  await open("Alpha");
  $("play").click();
  await settle();
  await release("alpha");
  const alpha = playing()[0];
  expect(alpha).toBeTruthy();

  $("play").click();                           // pause partway through
  alpha.currentTime = 1;
  await settle();
  expect(alpha.paused).toBe(true);

  await open("Beta");
  $("play").click();
  await settle();
  expect(alpha.plays).toBe(1);                 // not resumed behind Beta's page
  await release("beta");
  expect(playing().map(a => a.src)).not.toContain(alpha.src);
});

test("reading on plays the pack already in hand, and asks for nothing twice", async () => {
  await open("Alpha");
  $("play").click();
  await settle();
  await release("alpha");
  const first = playing()[0];
  expect(first).toBeTruthy();

  // The pack that follows was asked for while the first one was playing.
  await releaseNext();
  first.ended = true;
  first.paused = true;
  first.onended();
  await settle();
  expect(playing()).toHaveLength(1);
  expect(playing()[0]).not.toBe(first);
  // Every pack was asked for once: two chains sizing the same place
  // differently would make speech nobody ever hears.
  expect(new Set(clips.map(c => c.text)).size).toBe(clips.length);
});
