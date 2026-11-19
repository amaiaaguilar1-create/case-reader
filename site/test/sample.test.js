/**
 * The PDF that sample mode opens.
 *
 * It exists to show a reviewer what the reader does with a case PDF, so these
 * check that it still does: the parser has to find a running head, page
 * numbers, footnotes and an exhibit to skip, and prose that wraps across lines
 * to read whole. If a change to the parser or to scripts/make_sample_pdf.py
 * breaks any of that, the sample would quietly stop demonstrating it.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BODY, FOOTER, FOOTNOTE, HEADER, buildLayoutDocument, extractLayout,
} from "../src/lib/layout.js";
import { lineRuns } from "../src/lib/pageview.js";

const FILE = new URL("../src/sample/hollis-street-bakery.pdf", import.meta.url);

let doc;
beforeAll(async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(FILE));
  const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  doc = buildLayoutDocument("sample", await extractLayout(pdf));
});

const ofKind = kind => doc.sentences.filter(s => s.kind === kind);
const read = () => ofKind(BODY).map(s => s.text).join(" ");

describe("the sample PDF", () => {
  it("is two pages long", () => {
    expect(doc.pages).toHaveLength(2);
  });

  it("opens with the title, then the story", () => {
    const [title, first] = ofKind(BODY);
    expect(title.text).toBe("Should Hollis Street Bakery Buy a Second Oven?");
    expect(first.text).toMatch(/^On a wet Tuesday in March/);
  });

  it("has a running head on both pages, shown but not read", () => {
    const heads = ofKind(HEADER);
    expect(new Set(heads.map(s => s.page))).toEqual(new Set([0, 1]));
    expect(heads.every(s => s.text.includes("Case Reader sample"))).toBe(true);
    expect(read()).not.toContain("Case Reader sample");
  });

  it("has a page number at the foot of each page, not read", () => {
    expect(ofKind(FOOTER).map(s => s.text)).toEqual(["Page 1 of 2", "Page 2 of 2"]);
    expect(read()).not.toMatch(/Page \d of 2/);
  });

  it("has footnotes and an exhibit set as notes, not read", () => {
    const notes = ofKind(FOOTNOTE).map(s => s.text).join(" ");
    expect(notes).toContain("every figure here are invented.");
    expect(notes).toContain("skips it when reading aloud.");
    expect(notes).toContain("Exhibit 1");
    expect(read()).not.toContain("Exhibit 1");
    expect(read()).not.toContain("reading aloud");
  });

  it("drops the raised reference markers instead of reading them", () => {
    expect(read()).toContain("capped what she could sell.");
    expect(read()).not.toMatch(/sell\.1|price\.2|results\.3/);
  });

  it("wraps prose across lines and keeps each sentence whole", () => {
    const wrapped = ofKind(BODY).filter(s => lineRuns(s.words).length > 1);
    expect(wrapped.length).toBeGreaterThan(5);
    const opening = wrapped.find(s => s.text.startsWith("On a wet Tuesday"));
    expect(opening.text).toMatch(/listened to the oven tick as it cooled\.$/);
  });

  it("gives every spoken word a box to highlight", () => {
    for (const s of ofKind(BODY)) {
      for (const w of s.words) {
        expect(w.box.w).toBeGreaterThan(0);
        expect(w.box.h).toBeGreaterThan(0);
      }
    }
  });

  it("is original text, with nothing from a published case", () => {
    const all = doc.sentences.map(s => s.text).join(" ");
    expect(all).not.toMatch(/harvard|hbs|business school|all rights reserved/i);
  });
});
