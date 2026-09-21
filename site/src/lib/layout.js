/** PDF extraction that keeps page coordinates and separates prose from furniture.
 *
 * A port of core/layout.py for pdf.js. Each word carries:
 *
 * - where it sits on the page, so a page view can highlight the real render
 * - whether it's prose or page furniture (running heads, page numbers,
 *   footnotes, licensing boilerplate), so furniture can be skipped when reading
 *
 * Classification is heuristic and deliberately conservative: anything it isn't
 * confident about stays 'body', because wrongly skipping case narrative is far
 * worse than reading a stray page number.
 *
 * Where this differs from the Python side: PyMuPDF hands back a box and a
 * superscript flag per character, pdf.js hands back one box per text item (a
 * run of glyphs sharing a text matrix). So here superscripts are detected per
 * item from size and baseline rather than read from a font flag, and a word's
 * box is interpolated across its item rather than measured. Both are noted
 * again where they happen.
 */
import { chunkSentences, splitSentences, tokenize } from "./chunker.js";

export const BODY = "body";
export const HEADER = "header";
export const FOOTER = "footer";
export const FOOTNOTE = "footnote";
export const BOILERPLATE = "boilerplate";

/** Kinds that are page furniture rather than the document's prose. */
export const FURNITURE = new Set([HEADER, FOOTER, FOOTNOTE, BOILERPLATE]);

// Fractions of page height treated as the running head / foot bands.
const TOP_BAND = 0.10;
const BOT_BAND = 0.90;
// A line repeated in a band on at least this many pages is a running head/foot.
const RUNNING_MIN_PAGES = 2;
const RUNNING_MIN_FRACTION = 0.3;
// Notes are set meaningfully smaller than the narrative. Position is not part
// of the test: endnotes and source lists start at the top of their own pages.
const FOOTNOTE_SIZE_DELTA = 0.6;

// Consecutive lines closer than this multiple of typical leading are a wrap,
// not a paragraph.
const WRAP_LEADING = 1.4;

// A line is "tracked" when this share of its tokens are lone letters, which is
// how wide letter-spacing extracts. Display type, never prose -- and reading it
// aloud would spell it out character by character.
const TRACKED_MIN_TOKENS = 4;
const TRACKED_SHARE = 0.6;
const TRACKED_MIN_LETTERS = 2;
/** Superscripts that belong to the preceding number rather than being markers. */
const ORDINAL_SUFFIXES = new Set(["st", "nd", "rd", "th"]);

// --- pdf.js geometry -------------------------------------------------------
// Share of the font size that sits above the baseline. pdf.js gives a baseline,
// not a box, so a word's height is the em rather than the inked extent.
const ASCENT = 0.8;
// Two items belong to the same line when their em boxes overlap by this share
// of the shorter one. Loose enough to keep a raised footnote marker with its
// sentence, tight enough to keep the next line out.
const LINE_OVERLAP = 0.4;
// An item set this much smaller than its line, and raised off its baseline by
// this share of the line's size, is a superscript. PyMuPDF reports a font flag
// for this; pdf.js reports no flags at all, so it is inferred from geometry.
const SUPERSCRIPT_SIZE_DELTA = 0.6;
const SUPERSCRIPT_RISE = 0.1;
// A gap wider than this share of the font size is a word space; anything
// narrower is kerning inside a word. PDFs fragment words across items -- "1987"
// arrives as "19" and "87" -- and joining every item with a space is what makes
// a year read as two numbers. Measured on real case PDFs the two populations
// are far apart: intra-word gaps sit at 0.00em, real spaces at 0.20em and up.
const SPACE_GAP = 0.12;

// Rough per-character advance weights, used only to interpolate word boxes
// inside an item. Nothing downstream depends on them being exact.
const WIDE = new Set([..."MWmw@%"]);
const NARROW = new Set([..."ijltfIJ.,;:'\"`!|()[]{}-"]);

const PAGE_LABEL_RE = /^(page\s*)?[\divxlc]+(\s*(of|\/)\s*\d+)?$/i;
/** Publishers stamp a document number on the title page, e.g. "4-512-078". */
const CASE_ID_RE = /^\d-\d{3}-\d{3}$/;
// Matched against the line with whitespace removed, so letter-spaced title
// blocks ("4-512-078 R E V : ...") still register as the number line.
const CASE_ID_PREFIX_RE = /^\d-\d{3}-\d{3}/;
// Publisher boilerplate: the licensing and permissions block that repeats on
// every page. It is furniture, not prose, so it is skipped rather than read
// aloud -- including the per-reader watermark, which carries someone's name.
// These are matched, never removed from the file; the PDF is untouched.
const BOILERPLATE_RES = [
  /copyright\s*©/i,
  /all rights reserved/i,
  /president and fellows of harvard college/i,
  /this document is authorized for use only/i,
  /for the exclusive use of/i,
  /no part of this publication may be reproduced/i,
  /harvard business (school|publishing|review)/i,
  /hbsp\.harvard\.edu/i,
  /to order copies or request permission/i,
  /developed solely as the basis for class discussion/i,
  /not intended to serve as endorsements/i,
];

export function lineKind(line, pageH, bodySize, running) {
  const { text, size } = line;
  const top = line.y + line.h <= pageH * TOP_BAND;
  const bottom = line.y >= pageH * BOT_BAND;

  if (BOILERPLATE_RES.some(r => r.test(text))) return BOILERPLATE;
  if (running.has(signature(text))) return top ? HEADER : FOOTER;
  if ((top || bottom) && (PAGE_LABEL_RE.test(text) || CASE_ID_RE.test(text))) {
    return top ? HEADER : FOOTER;
  }
  if (CASE_ID_PREFIX_RE.test(text.replace(/\s+/g, ""))) return HEADER;
  if (isTracked(text)) return line.y < pageH / 2 ? HEADER : FOOTER;
  // Type set smaller than the narrative: footnotes, endnotes, source lists,
  // exhibit tables. None of it reads well aloud.
  if (size <= bodySize - FOOTNOTE_SIZE_DELTA) return FOOTNOTE;
  return BODY;
}

/** True for letter-spaced display type, which extracts as lone characters.
 *
 * Digits count toward the share so tracked dates ("J U N E 2 2 , 2 0 2 4")
 * register, but a few real letters are required as well -- otherwise an
 * exhibit table row of single digits would look like a tracked heading.
 */
export function isTracked(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < TRACKED_MIN_TOKENS) return false;
  const lone = tokens.filter(t => t.length === 1 && /[\p{L}\p{N}]/u.test(t));
  const letters = lone.filter(t => /\p{L}/u.test(t)).length;
  return lone.length >= TRACKED_SHARE * tokens.length
    && letters >= TRACKED_MIN_LETTERS;
}

/** Collapse digits and whitespace so 'Page 3' and 'Page 4' compare equal. */
function signature(text) {
  return text.split(/\s+/).filter(Boolean).join(" ").replace(/\d+/g, "#")
    .trim().toLowerCase();
}

/** Signatures that recur in the head/foot band across enough pages. */
export function runningSignatures(lines, pages) {
  const seen = new Map();
  for (const ln of lines) {
    const pageH = pages[ln.page].height;
    if (ln.y + ln.h <= pageH * TOP_BAND || ln.y >= pageH * BOT_BAND) {
      const sig = signature(ln.text);
      if (!seen.has(sig)) seen.set(sig, new Set());
      seen.get(sig).add(ln.page);
    }
  }
  const threshold = Math.max(RUNNING_MIN_PAGES, Math.round(pages.length * RUNNING_MIN_FRACTION));
  return new Set([...seen].filter(([, p]) => p.size >= threshold).map(([sig]) => sig));
}

/** Most common font size, weighted by how much text is set in it. */
export function bodySize(lines) {
  const tally = new Map();
  for (const ln of lines) {
    const key = Math.round(ln.size * 2) / 2;
    tally.set(key, (tally.get(key) || 0) + ln.weight);
  }
  let best = 0;
  let most = 0;
  for (const [size, weight] of tally) {
    if (weight > most) [best, most] = [size, weight];
  }
  return best;
}

/** Drop superscript reference markers, keeping ordinal suffixes.
 *
 * A marker is its own item in pdf.js (it has its own text matrix), so unlike
 * the Python side this walks items rather than characters. An ordinal's suffix
 * is also superscript, and dropping it would turn '70th' into '70' -- read
 * aloud as "seventy" instead of "seventieth".
 */
export function stripSuperscripts(items) {
  const kept = [];
  let i = 0;
  while (i < items.length) {
    if (!items[i].sup) {
      kept.push(items[i]);
      i += 1;
      continue;
    }
    let run = i;
    while (run < items.length && items[run].sup) run += 1;
    const text = items.slice(i, run).map(it => it.str).join("").trim().toLowerCase();
    const prev = kept.length ? kept.at(-1).str.trimEnd() : "";
    if (ORDINAL_SUFFIXES.has(text) && /\d$/.test(prev)) kept.push(...items.slice(i, run));
    i = run;
  }
  return kept;
}

/** Where `text.slice(from, to)` starts and how wide it is inside one item. */
function advance(item, from, to) {
  const weight = c => (WIDE.has(c) ? 1.6 : NARROW.has(c) ? 0.55 : 1);
  let before = 0;
  let span = 0;
  let total = 0;
  for (let i = 0; i < item.str.length; i++) {
    const w = weight(item.str[i]);
    total += w;
    if (i < from) before += w;
    else if (i < to) span += w;
  }
  if (!total) return [0, 0];
  return [item.w * before / total, item.w * span / total];
}

/** Split a line's items into words, dropping superscript markers.
 *
 * Two items join into one word when nothing but kerning separates them; that
 * is the whole fix for fragmented extraction. The box spans only the items
 * that survive, so a highlight never reaches out over a dropped marker.
 */
export function lineWords(line) {
  const words = [];
  let prev = null; // { word, right, size }
  let spaced = true; // whitespace (or the line start) separates what comes next
  for (const item of stripSuperscripts(line.items)) {
    for (const m of item.str.matchAll(/\S+/g)) {
      const [offset, width] = advance(item, m.index, m.index + m[0].length);
      const x = item.x + offset;
      if (m.index > 0) spaced = true; // maximal runs, so a space precedes this
      if (prev && !spaced && x - prev.right < SPACE_GAP * Math.min(prev.size, item.size)) {
        const w = prev.word;
        w.text += m[0];
        const bottom = Math.max(w.y + w.h, item.y + item.h);
        w.y = Math.min(w.y, item.y);
        w.h = bottom - w.y;
        w.w = Math.max(w.w, x + width - w.x);
      } else {
        prev = { word: {
          text: m[0], page: line.page, kind: line.kind, line: line.line,
          x, y: item.y, w: width, h: item.h,
        } };
        words.push(prev.word);
      }
      prev.right = x + width;
      prev.size = item.size;
      spaced = false;
    }
    if (/\s$/.test(item.str)) spaced = true;
  }
  return words;
}

/** Multiply pdf.js matrices: the page viewport by one item's text matrix. */
function combine(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

/** One pdf.js text item as a box in top-left page coordinates. */
function geometry(item, viewport) {
  const t = combine(viewport, item.transform);
  const size = Math.hypot(t[2], t[3]) || item.height || 0;
  return {
    str: item.str,
    size,
    x: t[4],
    w: item.width,
    // The viewport transform has already flipped y, so t[5] is the baseline
    // measured from the top of the rendered page.
    y: t[5] - size * ASCENT,
    h: size,
    sup: false,
  };
}

/** Group one page's text items into visual lines.
 *
 * pdf.js has no notion of blocks or lines, only items in stream order, so
 * lines are rebuilt from geometry: an item joins the line it overlaps
 * vertically unless it jumps back to the left, which means a new line or the
 * next column.
 */
export function linesFromItems(items, page, viewport, firstLine = 0) {
  const lines = [];
  let cur = null;
  for (const raw of items) {
    if (!("str" in raw) || !raw.str.trim()) continue;
    const it = geometry(raw, viewport);
    const fits = cur
      && Math.min(cur.y + cur.h, it.y + it.h) - Math.max(cur.y, it.y)
        >= LINE_OVERLAP * Math.min(cur.h, it.h)
      && it.x >= cur.right - it.size;
    if (!fits) {
      cur = { page, line: firstLine + lines.length, items: [], y: it.y, h: it.h, right: it.x };
      lines.push(cur);
    }
    cur.items.push(it);
    const bottom = Math.max(cur.y + cur.h, it.y + it.h);
    cur.y = Math.min(cur.y, it.y);
    cur.h = bottom - cur.y;
    cur.right = Math.max(cur.right, it.x + it.w);
  }
  return lines.map(finishLine).filter(ln => ln.text);
}

/** The line as one string, spacing items by the gap rule rather than blindly.
 *
 * Only used to classify the line and to compare running heads, but it has to
 * follow the same rule as the words or a fragmented head ("19 87") would never
 * match its twin on the next page.
 */
function joinItems(items) {
  let text = "";
  let prev = null;
  for (const it of items) {
    const spaced = /\s$/.test(text) || /^\s/.test(it.str) || !text;
    if (prev && !spaced && it.x - prev.right >= SPACE_GAP * Math.min(prev.size, it.size)) {
      text += " ";
    }
    text += it.str;
    prev = { right: it.x + it.w, size: it.size };
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Flag the line's superscripts and summarise it for classification. */
function finishLine(line) {
  const size = Math.max(...line.items.map(it => it.size));
  const baseline = line.items.find(it => it.size === size).y + size * ASCENT;
  for (const it of line.items) {
    it.sup = it.size <= size - SUPERSCRIPT_SIZE_DELTA
      && baseline - (it.y + it.size * ASCENT) > SUPERSCRIPT_RISE * size;
  }
  line.text = joinItems(line.items);
  // Judge size on normal type; a marker shouldn't make a body line look like a
  // footnote or vice versa.
  line.size = size;
  line.weight = line.text.length;
  return line;
}

/** Extract every word with its page box and a body/furniture classification.
 *
 * Takes an open pdf.js document so callers (and tests) own how it was loaded.
 */
export async function extractLayout(pdf) {
  const pages = [];
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();
    lines.push(...linesFromItems(content.items, n - 1, viewport.transform, lines.length));
  }
  const body = bodySize(lines);
  const running = runningSignatures(lines, pages);
  const words = [];
  for (const ln of lines) {
    ln.kind = lineKind(ln, pages[ln.page].height, body, running);
    words.push(...lineWords(ln));
  }
  return { pages, words };
}

function groupLines(words) {
  const lines = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last && last[0].page === w.page && last[0].line === w.line) last.push(w);
    else lines.push([w]);
  }
  return lines;
}

/** Median gap between stacked lines, ignoring paragraph-sized jumps. */
function typicalLeading(lines) {
  const heights = lines.map(ln => Math.max(...ln.map(w => w.h)));
  const sorted = [...heights].sort((a, b) => a - b);
  const medianH = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12;
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1][0].page !== lines[i][0].page) continue;
    const dy = lines[i][0].y - lines[i - 1][0].y;
    if (dy > 1 && dy <= medianH * 2.2) gaps.push(dy);
  }
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }
  return Math.max(medianH * 1.15, 1);
}

/** True when nxt continues prev's paragraph rather than starting a new one.
 *
 * The Python side can short-circuit on PyMuPDF's block ids; pdf.js has none,
 * so the decision rests entirely on line spacing: ordinary leading is a wrap,
 * a wider gap is a paragraph.
 */
function wrapped(prev, nxt, leading) {
  if (prev[0].page !== nxt[0].page) {
    const last = prev.at(-1).text.trimEnd();
    return Boolean(last) && !".!?:;".includes(last.at(-1));
  }
  const dy = nxt[0].y - prev[0].y;
  if (dy <= 1) return false; // side-by-side, not a line below
  return dy <= leading * WRAP_LEADING;
}

/** Join a run of words, breaking only at real paragraph gaps.
 *
 * Visual line wraps stay one sentence. A larger gap (or a page break after end
 * punctuation) is treated as a paragraph so headings and new sections split.
 *
 * `leading` is the document's typical body line spacing. Passing it in keeps a
 * short run (a title, a dek) from treating its own extra space as the wrap
 * interval and gluing onto the next paragraph.
 */
export function runText(words, leading) {
  const lines = groupLines(words);
  if (!lines.length) return "";
  const gap = leading ?? typicalLeading(lines);
  const parts = [lines[0].map(w => w.text).join(" ")];
  for (let i = 1; i < lines.length; i++) {
    parts.push(wrapped(lines[i - 1], lines[i], gap) ? " " : "\n\n");
    parts.push(lines[i].map(w => w.text).join(" "));
  }
  return parts.join("");
}

/** Split the word stream into consecutive same-kind runs. */
function runs(words) {
  const out = [];
  for (const w of words) {
    if (out.length && out.at(-1)[0].kind === w.kind) out.at(-1).push(w);
    else out.push([w]);
  }
  return out;
}

/** Match a chunk token to the next source word, resyncing if they diverge.
 *
 * Chunking is near-lossless but can hard-split a pathologically long token, so
 * rather than trusting a 1:1 walk we re-anchor on the token's text.
 */
function consume(run, cursor, token) {
  if (cursor >= run.length) return [cursor, null];
  if (run[cursor].text === token) return [cursor + 1, run[cursor]];
  for (let probe = cursor; probe < Math.min(cursor + 8, run.length); probe++) {
    if (token.startsWith(run[probe].text) || run[probe].text.startsWith(token)) {
      return [probe + 1, run[probe]];
    }
  }
  return [cursor + 1, run[cursor]];
}

/** Chunk a PDF into sentences carrying page boxes and a body/furniture kind.
 *
 * Runs of the same kind are chunked separately. The chunker merges short
 * sentences into their neighbours, so chunking everything together would let a
 * running header glue itself onto the first line of prose and get read.
 */
export function buildLayoutDocument(title, layout) {
  const doc = { title, pages: layout.pages, sentences: [], position: 0 };
  const leading = typicalLeading(groupLines(layout.words.filter(w => w.kind === BODY)));
  for (const run of runs(layout.words)) {
    let cursor = 0;
    for (const text of chunkSentences(splitSentences(runText(run, leading)))) {
      const words = tokenize(text).map(tok => {
        const [next, src] = consume(run, cursor, tok.text);
        cursor = next;
        const box = src
          ? { page: src.page, x: src.x, y: src.y, w: src.w, h: src.h }
          : { page: run[0].page, x: 0, y: 0, w: 0, h: 0 };
        return { ...tok, box };
      });
      doc.sentences.push({
        id: doc.sentences.length,
        text,
        words,
        kind: run[0].kind,
        page: words.length ? words[0].box.page : run[0].page,
      });
    }
  }
  return doc;
}
