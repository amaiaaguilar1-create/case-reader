import { describe, expect, it } from "vitest";
import { hasPages, lineRuns } from "../src/lib/pageview.js";
import { pagedDoc, proseDoc } from "./fixtures/paged.js";

describe("hasPages", () => {
  it("accepts a document with page sizes and the original file", () => {
    expect(hasPages(pagedDoc(["One two three."]))).toBe(true);
  });

  it("refuses anything that cannot be drawn", () => {
    expect(hasPages(proseDoc(["One two three."]))).toBe(false);
    expect(hasPages(null)).toBe(false);
    expect(hasPages({ ...pagedDoc(["A b."]), file: null })).toBe(false);
    expect(hasPages({ ...pagedDoc(["A b."]), pages: [] })).toBe(false);
  });
});

describe("lineRuns", () => {
  const words = boxes => boxes.map((box, i) => ({ text: `w${i}`, box }));

  it("merges the words of one line into a single band", () => {
    const [s] = pagedDoc(["Alpha beta gamma."]).sentences;
    const runs = lineRuns(s.words);
    expect(runs).toHaveLength(1);
    expect(runs[0].x).toBe(72);
    const last = s.words.at(-1).box;
    expect(runs[0].x + runs[0].w).toBe(last.x + last.w);
  });

  it("starts a new run when the words drop to the next line", () => {
    const runs = lineRuns(words([
      { page: 0, x: 72, y: 100, w: 40, h: 12 },
      { page: 0, x: 116, y: 100, w: 40, h: 12 },
      { page: 0, x: 72, y: 118, w: 40, h: 12 },
    ]));
    expect(runs.map(r => r.y)).toEqual([100, 118]);
  });

  it("keeps a run per page when a sentence crosses the break", () => {
    const runs = lineRuns(words([
      { page: 0, x: 72, y: 700, w: 40, h: 12 },
      { page: 1, x: 72, y: 700, w: 40, h: 12 },
    ]));
    expect(runs.map(r => r.page)).toEqual([0, 1]);
  });

  it("skips words the parser could not place", () => {
    expect(lineRuns(words([{ page: 0, x: 72, y: 100, w: 0, h: 0 }]))).toEqual([]);
    expect(lineRuns([{ text: "a" }])).toEqual([]);
    expect(lineRuns(undefined)).toEqual([]);
  });

  it("tolerates a small baseline wobble within one line", () => {
    const runs = lineRuns(words([
      { page: 0, x: 72, y: 100, w: 40, h: 12 },
      { page: 0, x: 116, y: 104, w: 40, h: 12 },
    ]));
    expect(runs).toHaveLength(1);
    expect(runs[0].h).toBe(16);
  });
});
