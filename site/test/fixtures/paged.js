/** A stand-in for what the PDF parser emits: page sizes in PDF points, and a
 *  box on every word with a top-left origin. Lets the page view be built and
 *  tested before the parser catches up. */

const LINE_H = 12;

/** Lay `lines` out as words on one page, 14pt apart, starting at (72, 72). */
export function pagedDoc(lines, { width = 612, height = 792, page = 0 } = {}) {
  const sentences = lines.map((line, id) => {
    const text = typeof line === "string" ? line : line.text;
    const kind = typeof line === "string" ? "body" : line.kind;
    let x = 72;
    const y = 72 + id * (LINE_H + 6);
    const words = text.split(/\s+/).map(w => {
      const box = { page, x, y, w: w.length * 6, h: LINE_H };
      x += w.length * 6 + 4;
      return { text: w, box };
    });
    return { id, text, words, kind };
  });
  return {
    title: "Fixture",
    sentences,
    pages: [{ width, height }],
    position: 0,
    file: new Blob(["%PDF-1.4"], { type: "application/pdf" }),
  };
}

/** The same shape minus the layout, as pasted text and .txt files produce. */
export function proseDoc(lines) {
  const doc = pagedDoc(lines);
  delete doc.pages;
  delete doc.file;
  for (const s of doc.sentences) for (const w of s.words) delete w.box;
  return doc;
}
