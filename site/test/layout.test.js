import { describe, expect, it } from "vitest";
import {
  BODY, BOILERPLATE, FOOTER, FOOTNOTE, FURNITURE, HEADER,
  buildLayoutDocument, extractLayout, isTracked, lineWords, runText,
  stripSuperscripts,
} from "../src/lib/layout.js";
import { makePdf, textWidth } from "./make-pdf.js";

const PAGE_W = 612;
const PAGE_H = 792;
const BODY_LINES = [
  "Robert took the helm of the family business in 2009. The board",
  "met each quarter to review the succession plan. Revenue grew",
  "steadily through the following decade, and the family held on.",
];

/** Open a fixture with pdf.js the way a browser would, minus the worker. */
async function open(pages) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({ data: makePdf(pages), verbosity: 0 }).promise;
}

async function layoutOf(pages) {
  return extractLayout(await open(pages));
}

/** Body paragraph as stacked 11pt lines, starting at `y` and wrapping tightly. */
function paragraph(y, size = 11, lines = BODY_LINES) {
  return lines.map((text, i) => ({ text, x: 72, y: y + i * (size + 3), size }));
}

/** The three-page case PDF: a running head, page numbers, and a footnote. */
function samplePages() {
  return [0, 1, 2].map(n => ({
    width: PAGE_W,
    height: PAGE_H,
    runs: [
      { text: "From Beirut With Love (A)", x: 72, y: 40, size: 9 },
      ...paragraph(110),
      { text: "1 A small note on the exhibit.", x: 72, y: 700, size: 7 },
      { text: String(n + 1), x: 300, y: 760, size: 9 },
    ],
  }));
}

/** Words grouped by the kind they were classified as. */
function kindsOf(layout) {
  const kinds = {};
  for (const w of layout.words) (kinds[w.kind] ??= new Set()).add(w.text);
  return kinds;
}

describe("tracked display type", () => {
  it.each([
    ["R E V : N O V E M B E R 1 , 2 0 1 8", true],
    ["J U N E 2 2 , 2 0 2 4", true],
    ["C H R I S T I N A R . W I N G", true],
    ["1 2 3 4 5", false], // exhibit row, not a heading
    ["A 1 2 3 4", false], // one stray letter isn't tracking
    ["2019 2020 2021 2022", false],
    ["He said it was a big deal", false],
    ["R E V", false], // too short to judge
  ])("%s -> %s", (text, tracked) => {
    expect(isTracked(text)).toBe(tracked);
  });
});

/** Items for `text` with the `tail` set as a raised, smaller superscript. */
function items(text, tail = "") {
  const out = [{ str: text, x: 0, y: 100, w: text.length * 5, h: 10, size: 10, sup: false }];
  if (tail) {
    out.push({
      str: tail, x: text.length * 5, y: 97, w: tail.length * 3, h: 6, size: 6, sup: true,
    });
  }
  return out;
}

describe("superscript markers", () => {
  it.each([
    ["anniversary", "a", "anniversary"], // footnote marker fused onto a word
    ["gas.", "2,3", "gas."], // multiple markers plus separator
    ["journey.", "17", "journey."],
    ["70", "th", "70th"], // ordinal suffix belongs to the number
    ["1", "st", "1st"],
    ["22", "nd", "22nd"],
    ["Group", "", "Group"], // nothing to strip
    ["Nuqul", "b", "Nuqul"],
  ])("%s + %s -> %s", (word, tail, expected) => {
    const kept = stripSuperscripts(items(word, tail));
    expect(kept.map(it => it.str).join("")).toBe(expected);
  });

  it("leaves nothing to read when a marker stands alone", () => {
    const line = { page: 0, line: 0, kind: BODY, items: items("", "12").slice(1) };
    expect(lineWords(line)).toEqual([]);
  });

  it("keeps the box off a dropped marker", () => {
    const line = { page: 0, line: 0, kind: BODY, items: items("anniversary", "a") };
    const [word] = lineWords(line);
    expect(word.text).toBe("anniversary");
    expect(word.x + word.w).toBeCloseTo("anniversary".length * 5, 5);
  });
});

describe("fragmented items", () => {
  it("joins pieces of a word without inventing spaces", async () => {
    // A real case PDF hands back "19" and "87" as two items a hair apart; the
    // old extractor joined every item with a space and read out "19 87".
    const runs = [];
    let x = 72;
    const put = (text, font = 1, size = 10) => {
      runs.push({ text, x, y: 120, size, font });
      x += textWidth(text, size);
    };
    put("Revenue reached ");
    put("19");
    put("87", 2); // a different font resource is what splits the item
    put(" million, up from ");
    put("1");
    put("50", 2);
    put(" million in the prior year.");
    const layout = await layoutOf([{ width: PAGE_W, height: PAGE_H, runs }]);
    const text = layout.words.map(w => w.text).join(" ");
    expect(text).toContain("1987");
    expect(text).toContain("150");
    expect(text).not.toContain("19 87");
  });

  it("gives a rejoined word one box spanning both pieces", async () => {
    const runs = [
      { text: "In 19", x: 72, y: 120, size: 10 },
      { text: "87", x: 72 + textWidth("In 19", 10), y: 120, size: 10, font: 2 },
    ];
    const layout = await layoutOf([{ width: PAGE_W, height: PAGE_H, runs }]);
    const year = layout.words.find(w => w.text === "1987");
    expect(year).toBeDefined();
    // The right edge is measured; the left edge is interpolated inside the
    // first item, so the box is close rather than exact (see layout.js).
    expect(year.x + year.w).toBeCloseTo(72 + textWidth("In 1987", 10), 1);
    expect(year.w).toBeGreaterThan(textWidth("87", 10));
  });

  it("keeps an ordinal whole but drops a reference marker", async () => {
    const runs = [];
    let x = 72;
    runs.push({ text: "The 70", x, y: 120, size: 10 });
    x += textWidth("The 70", 10);
    runs.push({ text: "th", x, y: 117, size: 6, font: 2 });
    x += textWidth("th", 6);
    runs.push({ text: " year ran on gas.", x, y: 120, size: 10 });
    x += textWidth(" year ran on gas.", 10);
    runs.push({ text: "2,3", x, y: 117, size: 6, font: 2 });
    const layout = await layoutOf([{ width: PAGE_W, height: PAGE_H, runs }]);
    const text = layout.words.map(w => w.text).join(" ");
    expect(text).toContain("70th");
    expect(text).toContain("gas.");
    expect(text).not.toContain("2,3");
  });
});

describe("page furniture", () => {
  it("classifies running heads, page numbers and notes", async () => {
    const layout = await layoutOf(samplePages());
    expect(layout.pages).toHaveLength(3);
    expect(layout.pages[0]).toEqual({ width: PAGE_W, height: PAGE_H });

    const kinds = kindsOf(layout);
    expect(kinds[HEADER]).toContain("Beirut");
    expect(kinds[FOOTER]).toContain("1");
    expect(kinds[FOOTNOTE]).toContain("exhibit.");
    expect(kinds[BODY]).toContain("succession");
  });

  it("treats licensing text as furniture wherever it sits", async () => {
    const layout = await layoutOf([{
      width: PAGE_W,
      height: PAGE_H,
      runs: [
        { text: "All rights reserved.", x: 72, y: 300, size: 11 },
        { text: "For the exclusive use of one student.", x: 72, y: 314, size: 11 },
      ],
    }]);
    expect(new Set(layout.words.map(w => w.kind))).toEqual(new Set([BOILERPLATE]));
  });

  it("calls small type a note anywhere on the page", async () => {
    // Endnotes and source lists start at the top of their own page.
    const layout = await layoutOf([
      { width: PAGE_W, height: PAGE_H, runs: paragraph(90, 10) },
      {
        width: PAGE_W,
        height: PAGE_H,
        runs: [{
          text: "Al Sayegh, Hadeel. Affirma Capital seeks a stake. Reuters, 2021.",
          x: 72, y: 60, size: 8,
        }],
      },
    ]);
    const kinds = kindsOf(layout);
    expect(kinds[FOOTNOTE]).toContain("Reuters,");
    expect(kinds[BODY]).toContain("succession");
  });

  it("only ever emits the five kinds the reader knows", async () => {
    const doc = buildLayoutDocument("sample", await layoutOf(samplePages()));
    const allowed = new Set([BODY, ...FURNITURE]);
    for (const s of doc.sentences) expect(allowed).toContain(s.kind);
  });

  it("never merges furniture into prose", async () => {
    const doc = buildLayoutDocument("sample", await layoutOf(samplePages()));
    const readable = doc.sentences.filter(s => s.kind === BODY).map(s => s.text).join(" ");
    expect(readable).not.toContain("From Beirut With Love");
    expect(readable).not.toContain("A small note");
    expect(readable).toContain("succession plan");
  });
});

describe("geometry handed to the page view", () => {
  it("gives every word a box on a real page", async () => {
    const doc = buildLayoutDocument("sample", await layoutOf(samplePages()));
    expect(doc.pages).toEqual(Array(3).fill({ width: PAGE_W, height: PAGE_H }));
    expect(doc.sentences.length).toBeGreaterThan(0);
    const body = doc.sentences.filter(s => s.kind === BODY);
    expect(body.length).toBeGreaterThan(0);
    for (const s of doc.sentences) {
      for (const w of s.words) {
        expect(w.box.page).toBeGreaterThanOrEqual(0);
        expect(w.box.page).toBeLessThan(3);
        expect(w.box.w).toBeGreaterThan(0);
        expect(w.box.h).toBeGreaterThan(0);
        expect(w.box.x + w.box.w).toBeLessThanOrEqual(PAGE_W);
        expect(w.box.y + w.box.h).toBeLessThanOrEqual(PAGE_H);
      }
    }
  });

  it("puts the y origin at the top of the page", async () => {
    const layout = await layoutOf([{
      width: PAGE_W, height: PAGE_H,
      runs: [{ text: "Near the top", x: 72, y: 100, size: 10 }],
    }]);
    // Baseline 100pt down the page, so the box sits just above it.
    expect(layout.words[0].y).toBeCloseTo(92, 1);
    expect(layout.words[0].x).toBeCloseTo(72, 1);
  });

  it("tags each sentence with the page its first word is on", async () => {
    const doc = buildLayoutDocument("sample", await layoutOf(samplePages()));
    for (const s of doc.sentences) expect(s.page).toBe(s.words[0].box.page);
    expect(new Set(doc.sentences.map(s => s.page))).toEqual(new Set([0, 1, 2]));
  });
});

/** One layout word; x1 is the line's right edge when it's the last word. */
function lw(text, { y, line, page = 0, x = 72, x1 = 540, h = 12 }) {
  return { text, page, line, kind: BODY, x, y, w: x1 - x, h };
}

describe("paragraphs", () => {
  it("joins wrapped lines even when the PDF split them", () => {
    const text = runText([
      lw("Each", { y: 100, line: 0, x1: 110 }),
      lw("summer", { y: 100, line: 0, x: 110, x1: 160 }),
      lw("fortunes", { y: 100, line: 0, x: 160 }),
      lw("gather", { y: 121, line: 1, x1: 130 }),
      lw("picnic.", { y: 121, line: 1, x: 130, x1: 400 }),
    ]);
    expect(text).not.toContain("\n\n");
    expect(text).toContain("fortunes gather");
  });

  it("still splits at a real paragraph gap", () => {
    expect(runText([
      lw("Short", { y: 100, line: 0, x1: 130 }),
      lw("line.", { y: 100, line: 0, x: 130, x1: 200 }),
      lw("Next", { y: 144, line: 1, x1: 140 }),
      lw("paragraph.", { y: 144, line: 1, x: 140, x1: 280 }),
    ])).toBe("Short line.\n\nNext paragraph.");
  });

  it("does not let a title's loose spacing glue on the next paragraph", () => {
    expect(runText([
      lw("Cousin", { y: 128, line: 0 }),
      lw("Scathing", { y: 162, line: 1 }),
    ], 21)).toBe("Cousin\n\nScathing");
  });

  it("keeps a sentence split across two lines in one spoken chunk", async () => {
    const doc = buildLayoutDocument("wrap", await layoutOf([{
      width: PAGE_W,
      height: PAGE_H,
      runs: [
        { text: "Each summer the heirs to one of America's biggest liquor", x: 72, y: 120, size: 10 },
        { text: "fortunes gather in the heart of bourbon country for a picnic.", x: 72, y: 134, size: 10 },
        { text: "A later paragraph starts here after a real gap.", x: 72, y: 178, size: 10 },
      ],
    }]));
    const wrapped = doc.sentences.filter(s => s.kind === BODY && s.text.includes("liquor fortunes"));
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.some(s => s.text.endsWith("picnic."))).toBe(true);
    expect(doc.sentences.some(s => s.text.startsWith("A later paragraph"))).toBe(true);
    for (const s of wrapped) expect(s.words.every(w => w.box)).toBe(true);
  });
});
