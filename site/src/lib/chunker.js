export const MIN_CHARS = 40;
export const MAX_CHARS = 480;

const SENT_RE = /(?<=[.!?])["')\]]*\s+(?=["'([]?[A-Z0-9])/;
const WORD_RE = /\S+/g;
const CLAUSE_RE = /[,;:\u2014\u2013]\s+/;

export function splitSentences(text) {
  const out = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const block = raw.split(/\s+/).join(" ").trim();
    if (!block) continue;
    out.push(...block.split(SENT_RE).map(s => s.trim()).filter(Boolean));
  }
  return out;
}

function splitLong(sent) {
  if (sent.length <= MAX_CHARS) return [sent];
  const parts = [];
  let cur = "";
  for (const piece of sent.split(CLAUSE_RE)) {
    const cand = cur ? `${cur}, ${piece}`.replace(/^, |, $/g, "") : piece;
    if (cand.length > MAX_CHARS && cur) {
      parts.push(cur);
      cur = piece;
    } else {
      cur = cand;
    }
  }
  if (cur) parts.push(cur);
  const final = [];
  for (let p of parts) {
    while (p.length > MAX_CHARS) {
      let cut = p.lastIndexOf(" ", MAX_CHARS);
      if (cut <= 0) cut = MAX_CHARS;
      final.push(p.slice(0, cut));
      p = p.slice(cut).trim();
    }
    if (p) final.push(p);
  }
  return final;
}

export function chunkSentences(sentences) {
  const expanded = sentences.flatMap(splitLong);
  const chunks = [];
  for (const s of expanded) {
    if (
      chunks.length
      && (s.length < MIN_CHARS || chunks.at(-1).length < MIN_CHARS)
      && chunks.at(-1).length + 1 + s.length <= MAX_CHARS
    ) {
      chunks[chunks.length - 1] += ` ${s}`;
    } else {
      chunks.push(s);
    }
  }
  return chunks;
}

export function packForSpeech(items, limit = MAX_CHARS) {
  if (!items.length) return [];
  const [sid0, kind0, text0] = items[0];
  const packed = [sid0];
  let size = text0.length;
  for (const [sid, kind, text] of items.slice(1)) {
    if (kind !== kind0) break;
    const nxt = size + 1 + text.length;
    if (nxt > limit) break;
    packed.push(sid);
    size = nxt;
  }
  return packed;
}

export function tokenize(text) {
  return [...text.matchAll(WORD_RE)].map(m => ({
    text: m[0], start: m.index, end: m.index + m[0].length,
  }));
}

export function kindOf(text) {
  const t = text.trim();
  if (/^\d{1,4}$/.test(t)) return "header";
  if (t.length < 48 && t.length > 1 && t === t.toUpperCase() && /[A-Z]/.test(t)) {
    return "header";
  }
  return "body";
}

export function buildDocument(title, text) {
  const sentences = chunkSentences(splitSentences(text)).map((chunk, id) => ({
    id,
    text: chunk,
    words: tokenize(chunk),
    kind: kindOf(chunk),
  }));
  return { title, sentences, position: 0 };
}
