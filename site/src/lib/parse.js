import { buildDocument } from "./chunker.js";
import { buildLayoutDocument, extractLayout } from "./layout.js";

export class ScannedPDFError extends Error {
  constructor() {
    super("This PDF looks like a scan of a page. Case Reader needs text it can select.");
    this.name = "ScannedPDFError";
  }
}

function fromPlain(title, text) {
  const doc = buildDocument(title || "Untitled", text);
  if (!doc.sentences.length) {
    throw new Error("Nothing readable turned up in that file.");
  }
  // Pasted text has no pages to show, but the field is always there so callers
  // never have to ask which kind of document they were handed.
  doc.pages = [];
  return doc;
}

export function parseText(title, text) {
  return fromPlain(title, text);
}

export async function parseFile(file) {
  const name = file.name || "Untitled";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  const title = name.replace(/\.[^.]+$/, "") || "Untitled";

  if (ext === ".pdf") return parsePdf(file, title);
  if (ext === ".txt" || ext === ".md" || ext === "") {
    return fromPlain(title, await file.text());
  }
  throw new Error("Try a PDF, or paste the text instead.");
}

async function parsePdf(file, title) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const layout = await extractLayout(pdf);
  // A scan has a page image and next to no selectable text.
  const chars = layout.words.reduce((n, w) => n + w.text.length, 0);
  if (chars < 40) throw new ScannedPDFError();
  const doc = buildLayoutDocument(title, layout);
  if (!doc.sentences.length) {
    throw new Error("Nothing readable turned up in that file.");
  }
  doc.file = file;
  return doc;
}

export const SAMPLE = {
  title: "A short listen",
  text: `Case Reader is for the days you would rather hear a document than stare at it.

Add a PDF or paste anything. Press play. A warm voice reads, and the words light up as they are spoken. The voice lives on this device, so your files never leave it.

That is the whole idea. Quiet, private, and simple enough to hand to someone you love.`,
};
