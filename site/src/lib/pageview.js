/** The original-page view: the uploaded PDF drawn to canvas, with the reading
 *  highlight laid over the words where they actually sit on the page.
 *
 *  The parser hands us PDF points with a top-left origin. Nothing here works
 *  in pixels: every box is positioned as a percentage of its page, so one set
 *  of numbers tracks the canvas at whatever width it happens to render --
 *  a phone, a wide window, or the moment in between while it resizes.
 */

// A render this wide is already sharper than any screen shows it, and the
// canvas costs four bytes a pixel whether or not they are visible.
const MAX_DEVICE_PX = 2400;
// Draw a screen and a half ahead, so scrolling meets finished pages.
const LAZY_MARGIN = "150% 0px";
// A render that is within this much of the width we want still looks sharp;
// redrawing it on every resize tick would only cost time.
const SHARP_ENOUGH = 1.15;

let gen = 0;          // bumped on unmount, so stale renders can bow out
let sheets = [];      // one per page: { el, canvas, ov, index, task, pending }
let pages = [];       // page sizes in PDF points
let pdf = null;       // promise of the open PDFDocumentProxy
let io = null;
let ro = null;
let resizeTimer = 0;

let pdfjsLib = null;
function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = import("pdfjs-dist").then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).href;
      return lib;
    });
  }
  return pdfjsLib;
}

/** Can this document be shown as pages? Pasted text, .txt files, and PDFs
 *  imported before the parser recorded boxes have prose and nothing else. */
export function hasPages(doc) {
  return !!(doc && Array.isArray(doc.pages) && doc.pages.length && doc.file);
}

/** True once mount() has laid out sheets for the open document. */
export function mounted() {
  return sheets.length > 0;
}

function place(el, r, page) {
  el.style.left = `${100 * r.x / page.width}%`;
  el.style.top = `${100 * r.y / page.height}%`;
  el.style.width = `${100 * r.w / page.width}%`;
  el.style.height = `${100 * r.h / page.height}%`;
}

/** Merge a sentence's word boxes into one rect per visual line. A sentence
 *  that wraps then gets a clean band per line instead of a box per word, with
 *  no gaps at the spaces. Words the parser could not place are skipped. */
export function lineRuns(words) {
  const runs = [];
  for (const w of words || []) {
    const b = w?.box;
    if (!b || !(b.w > 0 && b.h > 0)) continue;
    const last = runs.at(-1);
    // Same page and roughly the same baseline: still the same line.
    if (last && last.page === b.page && Math.abs(b.y - last.y) <= last.h * 0.6) {
      const right = Math.max(last.x + last.w, b.x + b.w);
      const bottom = Math.max(last.y + last.h, b.y + b.h);
      last.x = Math.min(last.x, b.x);
      last.y = Math.min(last.y, b.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      runs.push({ page: b.page, x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }
  return runs;
}

/** Lay out one sheet per page, wire up click-to-seek, and start the PDF.
 *  Resolves once the file has opened; rejects if it cannot be read, which
 *  tells the caller to fall back to prose. DOM is in place before the first
 *  await, so mounted() is already true when this returns a promise. */
export async function mount(host, doc, onSeek) {
  unmount(host);
  const mine = ++gen;
  pages = doc.pages;

  const frag = document.createDocumentFragment();
  pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "sheet";
    // Hold the page's shape before its render lands, so nothing jumps.
    el.style.aspectRatio = `${p.width} / ${p.height}`;
    el.dataset.i = i;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Page ${i + 1}`);
    const ov = document.createElement("div");
    ov.className = "ov";
    el.append(canvas, ov);
    frag.append(el);
    sheets.push({ el, canvas, ov, index: i, task: null, pending: 0 });
  });
  host.append(frag);

  for (const s of doc.sentences) {
    for (const r of lineRuns(s.words)) {
      const sh = sheets[r.page];
      if (!sh) continue;
      const hit = document.createElement("div");
      // Headers, footers and footnotes are part of the page and stay visible;
      // they are just not somewhere the voice can be sent.
      hit.className = "hit" + (s.kind === "body" ? "" : " furn");
      hit.dataset.s = s.id;
      place(hit, r, pages[r.page]);
      sh.ov.append(hit);
    }
  }
  host.onclick = e => {
    const hit = e.target.closest(".hit:not(.furn)");
    if (hit) onSeek(+hit.dataset.s);
  };

  pdf = openPdf(doc.file);

  // Only draw what is near the viewport, and give the canvas back when it
  // leaves: a long case at device resolution would otherwise hold a few
  // hundred megabytes of pixels at once.
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const sh = sheets[+e.target.dataset.i];
      if (!sh) continue;
      if (e.isIntersecting) draw(sh, mine);
      else release(sh);
    }
  }, { root: host.closest(".reader"), rootMargin: LAZY_MARGIN });
  for (const sh of sheets) io.observe(sh.el);

  // Rotating a phone or dragging a window wider leaves the render soft.
  ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const sh of sheets) if (sh.canvas.width) draw(sh, mine);
    }, 180);
  });
  ro.observe(host);

  await pdf;
}

export function unmount(host) {
  gen++;
  io?.disconnect();
  ro?.disconnect();
  clearTimeout(resizeTimer);
  io = ro = null;
  for (const sh of sheets) release(sh);
  sheets = [];
  pages = [];
  const closing = pdf;
  pdf = null;
  closing?.then(d => d.destroy()).catch(() => {});
  if (host) {
    host.onclick = null;
    host.innerHTML = "";
  }
}

async function openPdf(file) {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  return lib.getDocument({ data }).promise;
}

/** The width, in real device pixels, this sheet deserves right now. */
function targetPx(el) {
  const css = el.clientWidth;
  if (!css) return 0;
  return Math.min(Math.round(css * (window.devicePixelRatio || 1)), MAX_DEVICE_PX);
}

async function draw(sh, mine) {
  const want = targetPx(sh.el);
  if (!want || sh.canvas.width * SHARP_ENOUGH >= want || sh.pending === want) return;
  sh.pending = want;
  let page;
  try {
    page = await (await pdf).getPage(sh.index + 1);
  } catch {
    sh.pending = 0;
    return;
  }
  // The document may have closed, or a resize may have asked for another
  // width, while the page was being fetched.
  if (mine !== gen || sh.pending !== want) return;
  const viewport = page.getViewport({ scale: want / page.getViewport({ scale: 1 }).width });
  sh.task?.cancel();
  sh.canvas.width = Math.round(viewport.width);
  sh.canvas.height = Math.round(viewport.height);
  const canvasContext = sh.canvas.getContext("2d", { alpha: false });
  sh.task = page.render({ canvasContext, viewport });
  try {
    await sh.task.promise;
  } catch { /* cancelled by a redraw or a closed document */ }
  sh.task = null;
  sh.pending = 0;
}

function release(sh) {
  sh.task?.cancel();
  sh.task = null;
  sh.pending = 0;
  sh.canvas.width = sh.canvas.height = 0;
}

function clearMarks(cls) {
  for (const sh of sheets) {
    for (const el of sh.ov.querySelectorAll(`.${cls}`)) el.remove();
  }
}

/** Tint the sentence being read. Returns its first rect, for scrolling. */
export function paintSentence(sentence) {
  clearMarks("sb");
  let first = null;
  for (const r of lineRuns(sentence?.words)) {
    const sh = sheets[r.page];
    if (!sh) continue;
    const el = document.createElement("div");
    el.className = "sb";
    place(el, r, pages[r.page]);
    sh.ov.append(el);
    first ||= el;
  }
  return first;
}

/** Emphasize one word inside the tinted sentence. */
export function paintWord(sentence, wi) {
  clearMarks("wb");
  const b = sentence?.words?.[wi]?.box;
  if (!b || !(b.w > 0 && b.h > 0)) return;
  const sh = sheets[b.page];
  if (!sh) return;
  const el = document.createElement("div");
  el.className = "wb";
  place(el, b, pages[b.page]);
  sh.ov.append(el);
}

export function clearWord() {
  clearMarks("wb");
}
