import { describe, expect, it } from "vitest";
import {
  MAX_CHARS, buildDocument, chunkSentences, packForSpeech, splitSentences,
} from "../src/lib/chunker.js";
import { estimateWordTimings } from "../src/lib/timing.js";

describe("chunker", () => {
  it("splits basic sentences", () => {
    expect(splitSentences("Hello world. This is a test! Does it work? Yes."))
      .toEqual(["Hello world.", "This is a test!", "Does it work?", "Yes."]);
  });

  it("does not oversplit abbreviations before lowercase", () => {
    const sents = splitSentences("We use models, e.g. small ones, daily. Next sentence here.");
    expect(sents).toHaveLength(2);
  });

  it("splits long sentences", () => {
    const long = Array.from({ length: 20 }, (_, i) => `clause number ${i} with several words`).join(", ") + ".";
    const chunks = chunkSentences([long]);
    expect(chunks.every(c => c.length <= MAX_CHARS)).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("merges short sentences", () => {
    expect(chunkSentences(["Hi.", "Ok.", "Sure thing."])).toHaveLength(1);
  });

  it("packs a paragraph and stops at kind change", () => {
    expect(packForSpeech([
      [5, "body", "The Group comprised over 30 companies located in eight countries."],
      [6, "body", "Its flagship entity was a leader in hygienic paper products."],
      [7, "header", "624-030"],
    ])).toEqual([5, 6]);
    expect(packForSpeech([
      [1, "body", "Hello there, this is a short line."],
      [2, "footnote", "See exhibit 1."],
    ])).toEqual([1]);
  });

  it("keeps word offsets aligned", () => {
    const doc = buildDocument("t", "The quick brown fox jumps over the lazy dog.");
    for (const s of doc.sentences) {
      for (const w of s.words) {
        expect(s.text.slice(w.start, w.end)).toBe(w.text);
      }
    }
  });

  it("treats empty input as no sentences", () => {
    expect(buildDocument("t", "").sentences).toEqual([]);
    expect(buildDocument("t", "   \n\n  ").sentences).toEqual([]);
  });
});

describe("timing", () => {
  it("covers the duration monotonically", () => {
    const words = "Hello there, friend.".split(" ").map(text => ({ text }));
    const times = estimateWordTimings(words, 2);
    expect(times).toHaveLength(3);
    expect(times[0][0]).toBe(0);
    expect(times.at(-1)[1]).toBe(2);
    for (let i = 1; i < times.length; i++) {
      expect(times[i][0]).toBeGreaterThanOrEqual(times[i - 1][1] - 1e-9);
    }
  });
});
