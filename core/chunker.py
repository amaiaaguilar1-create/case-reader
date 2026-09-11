"""Split text into sentences, then group into TTS chunks.

Rules (from spec):
- merge very short sentences (< MIN_CHARS) into neighbors
- split sentences longer than MAX_CHARS at clause boundaries (, ; : —) else hard-split
"""
from __future__ import annotations
import re
from .model import Document, Sentence, Word

MIN_CHARS = 25
MAX_CHARS = 280

# Sentence splitter: end punctuation followed by space+capital/quote/digit, or newline blocks.
_SENT_RE = re.compile(r'(?<=[.!?])["\')\]]*\s+(?=["\'(\[]?[A-Z0-9])')
_WORD_RE = re.compile(r"\S+")
_CLAUSE_RE = re.compile(r"[,;:\u2014\u2013]\s+")


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        block = " ".join(block.split())
        if not block:
            continue
        out.extend(p.strip() for p in _SENT_RE.split(block) if p.strip())
    return out


def _split_long(sent: str) -> list[str]:
    if len(sent) <= MAX_CHARS:
        return [sent]
    # try clause boundaries
    parts, cur = [], ""
    for piece in _CLAUSE_RE.split(sent):
        cand = (cur + ", " + piece).strip(", ") if cur else piece
        if len(cand) > MAX_CHARS and cur:
            parts.append(cur)
            cur = piece
        else:
            cur = cand
    if cur:
        parts.append(cur)
    # hard-split any survivors at word boundaries
    final = []
    for p in parts:
        while len(p) > MAX_CHARS:
            cut = p.rfind(" ", 0, MAX_CHARS)
            cut = cut if cut > 0 else MAX_CHARS
            final.append(p[:cut])
            p = p[cut:].strip()
        final.append(p)
    return [f for f in final if f]


def chunk_sentences(sentences: list[str]) -> list[str]:
    """Merge shorts, split longs. Output = list of TTS-ready chunk texts."""
    expanded: list[str] = []
    for s in sentences:
        expanded.extend(_split_long(s))
    chunks: list[str] = []
    for s in expanded:
        if chunks and (len(s) < MIN_CHARS or len(chunks[-1]) < MIN_CHARS) \
                and len(chunks[-1]) + 1 + len(s) <= MAX_CHARS:
            chunks[-1] = chunks[-1] + " " + s
        else:
            chunks.append(s)
    return chunks


def build_document(title: str, text: str) -> Document:
    doc = Document(title=title)
    for i, chunk in enumerate(chunk_sentences(split_sentences(text))):
        words = [Word(m.group(), m.start(), m.end()) for m in _WORD_RE.finditer(chunk)]
        doc.sentences.append(Sentence(id=i, text=chunk, words=words))
    return doc
