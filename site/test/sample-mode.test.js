// @vitest-environment jsdom
/**
 * Sample mode: the reader without the password, and without the library.
 *
 * The page is driven through its real buttons with the library, the gate and
 * the voice stubbed out. Every library call is recorded, because the promise
 * sample mode makes is that it never makes one: the password still guards the
 * reader's own documents, and the sample is held in memory and never saved.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildDocument, tokenize } from "../src/lib/chunker.js";

const HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const BODY = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"))
  .replace(/<script[\s\S]*?<\/script>/g, "");

// A running head, then sentences of forty characters or more, so the chunker
// keeps them apart.
const SAMPLE = buildDocument("sample", "Should the bakery on the corner buy a second oven? "
  + "Rosa listened to the oven tick as it cooled, and thought about Saturday.");
SAMPLE.sentences = [
  { id: 0, text: "Hollis Street Bakery", words: tokenize("Hollis Street Bakery"), kind: "header" },
  ...SAMPLE.sentences.map(s => ({ ...s, id: s.id + 1 })),
];
SAMPLE.pages = [];

/** Library calls, by name. Sample mode must leave this empty. */
let library = [];
/** What the voice step was told to fetch, and what was spoken. */
let chose = null;
let spoken = [];
let voiceSaved = true;
let fetched = [];

vi.mock("../src/lib/db.js", () => {
  const touch = name => async () => { library.push(name); return name === "listDocs" ? [] : null; };
  return {
    listDocs: touch("listDocs"),
    getDoc: touch("getDoc"),
    saveDoc: touch("saveDoc"),
    deleteDoc: touch("deleteDoc"),
    savePosition: touch("savePosition"),
    // Settings, not documents: the voice download is shared with the full app.
    metaGet: async key => (key === "voiceSaved" ? voiceSaved : false),
    metaSet: async () => {},
  };
});
vi.mock("../src/lib/parse.js", () => ({
  parseFile: async file => {
    expect(file.type).toBe("application/pdf");
    return structuredClone(SAMPLE);
  },
  parseText: () => { throw new Error("not in sample mode"); },
  SAMPLE: { title: "", text: "" },
}));
vi.mock("../src/lib/gate.js", () => ({
  unlocked: () => false, verify: async () => false, remember: () => {}, forget: () => {},
}));
vi.mock("../src/lib/backend.js", () => ({
  setVoicePreference: async choice => { chose = choice; },
  voicePreference: () => chose,
}));
vi.mock("../src/lib/tts.js", async () => {
  const real = await vi.importActual("../src/lib/tts.js");
  return {
    ...real,
    voiceReady: () => true,
    loadVoice: async (onProgress = () => {}) => { onProgress(1); },
    dropGuesses: () => {},
    raise: () => {},
    synthesize: async (text, words) => {
      spoken.push(text);
      return { text, url: `blob:${spoken.length}`, duration: 2, ms: 1900,
        timings: words.map((_, i) => [i, i + 1]) };
    },
  };
});

class FakeAudio {
  constructor(url) { this.src = url; this.paused = true; this.currentTime = 0; this.duration = 2; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

const $ = id => document.getElementById(id);
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

async function load(path) {
  history.replaceState(null, "", path);
  vi.resetModules();
  await import("../src/main.js");
  await settle();
}

beforeEach(() => {
  library = [];
  spoken = [];
  fetched = [];
  chose = null;
  voiceSaved = true;
  document.body.innerHTML = BODY;
  globalThis.Audio = FakeAudio;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.fetch = async url => {
    fetched.push(String(url));
    return { ok: true, blob: async () => new Blob(["%PDF-1.4"]) };
  };
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.resetModules();
  history.replaceState(null, "", "/");
});

test("without the password or ?sample, the page stays locked", async () => {
  await load("/");
  expect($("gate").hidden).toBe(false);
  expect($("app").hidden).toBe(true);
  expect($("sampleTry")).toBeTruthy();
  expect(library).toEqual([]);
});

test("?sample opens the sample straight away, without the library", async () => {
  await load("/?sample");
  expect($("gate").hidden).toBe(true);
  expect($("app").hidden).toBe(false);
  expect(fetched).toEqual([expect.stringMatching(/hollis-street-bakery.*\.pdf/)]);
  expect($("topTitle").textContent).toBe("Hollis Street Bakery (sample)");
  expect($("prose").textContent).toContain("second oven");
  // It starts on the first sentence that is read, not the running head.
  expect(document.querySelector(".sent.now").id).toBe("s1");
  // The library and the ways into it are out of sight.
  expect($("lib").hidden).toBe(true);
  expect($("lib").children).toHaveLength(0);
  expect($("addBtn").hidden).toBe(true);
  expect($("sampleRail").hidden).toBe(false);
  expect(library).toEqual([]);
});

test("the sample plays, seeks, and still never touches the library", async () => {
  await load("/?sample");
  $("play").click();
  await settle();
  // The opening may be part of a sentence: it is sized to start quickly.
  expect(spoken[0]).toMatch(/^Should the bakery/);
  // Click-to-seek on a word of the second sentence.
  document.querySelector('.w[data-s="2"]').click();
  await settle();
  expect(spoken.some(t => t.startsWith("Rosa listened"))).toBe(true);
  // Speed and voice are the full app's controls.
  $("speed").click();
  expect($("speedTxt").textContent).toBe("1.25x");
  expect(library).toEqual([]);
});

test("the lock screen's button opens the sample and makes the link shareable", async () => {
  await load("/");
  $("sampleTry").click();
  await settle();
  expect(location.search).toBe("?sample");
  expect($("app").hidden).toBe(false);
  expect($("topTitle").textContent).toBe("Hollis Street Bakery (sample)");
  expect(library).toEqual([]);
});

test("a first visit is asked which voice to download before the sample opens", async () => {
  voiceSaved = false;
  await load("/?sample");
  expect($("onboard").hidden).toBe(false);
  const step = document.querySelector('.onboard-card[data-step="voice"]');
  expect(step.hidden).toBe(false);
  expect(step.textContent).toContain("92 MB");
  expect(step.textContent).toContain("326 MB");
  expect(fetched).toEqual([]);

  $("voiceSmall").click();
  await settle();
  expect(chose).toBe("small");
  expect($("onboard").hidden).toBe(true);
  expect($("topTitle").textContent).toBe("Hollis Street Bakery (sample)");
  expect(library).toEqual([]);
});
