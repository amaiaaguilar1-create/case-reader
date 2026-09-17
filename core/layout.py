"""PDF extraction that keeps page coordinates and separates prose from furniture.

parsers.parse_pdf throws layout away, which is fine for reflowed reading but
loses the page. This module keeps two extra things per word:

- where it sits on the page, so the reader can highlight the real PDF render
- whether it's prose or page furniture (running heads, page numbers,
  footnotes, licensing boilerplate), so furniture can be skipped when reading

Classification is heuristic and deliberately conservative: anything it isn't
confident about stays 'body', because wrongly skipping case narrative is far
worse than reading a stray page number.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .chunker import chunk_sentences, split_sentences, tokenize
from .model import Document, Sentence, Word

BODY = "body"
HEADER = "header"
FOOTER = "footer"
FOOTNOTE = "footnote"
BOILERPLATE = "boilerplate"

#: Kinds that are page furniture rather than the document's prose.
FURNITURE = frozenset({HEADER, FOOTER, FOOTNOTE, BOILERPLATE})

# Fractions of page height treated as the running head / foot bands.
TOP_BAND = 0.10
BOT_BAND = 0.90
# A line repeated in a band on at least this many pages is a running head/foot.
RUNNING_MIN_PAGES = 2
RUNNING_MIN_FRACTION = 0.3
# Notes are set meaningfully smaller than the narrative. Position is not part
# of the test: endnotes and source lists start at the top of their own pages.
FOOTNOTE_SIZE_DELTA = 0.6

# Consecutive lines closer than this multiple of typical leading are a wrap,
# not a paragraph. Tuned on HBS cases (~12pt wraps vs ~21pt paras) and
# print-to-PDF articles (~21pt wraps vs ~33pt paras).
WRAP_LEADING = 1.4

# A line is "tracked" when this share of its tokens are lone letters, which is
# how wide letter-spacing extracts. Display type, never prose -- and reading it
# aloud would spell it out character by character.
TRACKED_MIN_TOKENS = 4
TRACKED_SHARE = 0.6
TRACKED_MIN_LETTERS = 2
#: Superscripts that belong to the preceding number rather than being markers.
ORDINAL_SUFFIXES = frozenset({"st", "nd", "rd", "th"})

_PAGE_LABEL_RE = re.compile(r"^(page\s*)?[\divxlc]+(\s*(of|/)\s*\d+)?$", re.I)
_CASE_ID_RE = re.compile(r"^\d-\d{3}-\d{3}$")
# Matched against the line with whitespace removed, so letter-spaced title
# blocks ("9-619-024 R E V : ...") still register as the case number line.
_CASE_ID_PREFIX_RE = re.compile(r"^\d-\d{3}-\d{3}")
_BOILERPLATE_RES = tuple(re.compile(p, re.I) for p in (
    r"copyright\s*\u00a9",
    r"all rights reserved",
    r"president and fellows of harvard college",
    r"this document is authorized for use only",
    r"for the exclusive use of",
    r"no part of this publication may be reproduced",
    r"harvard business (school|publishing|review)",
    r"hbsp\.harvard\.edu",
    r"to order copies or request permission",
    r"developed solely as the basis for class discussion",
    r"not intended to serve as endorsements",
))


@dataclass
class LayoutWord:
    """One extracted word, with where it is and what kind of text it is."""
    text: str
    page: int
    bbox: tuple[float, float, float, float]
    kind: str = BODY
    block: int = 0
    line: int = 0


@dataclass
class PdfLayout:
    pages: list[tuple[float, float]] = field(default_factory=list)  # (width, height)
    words: list[LayoutWord] = field(default_factory=list)

    @property
    def has_text(self) -> bool:
        return any(w.text.strip() for w in self.words)


def _line_kind(line: dict, page_h: float, body_size: float, running: set[str]) -> str:
    text, size = line["text"], line["size"]
    y0, y1 = line["bbox"][1], line["bbox"][3]
    top, bottom = y1 <= page_h * TOP_BAND, y0 >= page_h * BOT_BAND

    if any(r.search(text) for r in _BOILERPLATE_RES):
        return BOILERPLATE
    if _signature(text) in running:
        return HEADER if top else FOOTER
    if (top or bottom) and (_PAGE_LABEL_RE.match(text) or _CASE_ID_RE.match(text)):
        return HEADER if top else FOOTER
    if _CASE_ID_PREFIX_RE.match(re.sub(r"\s+", "", text)):
        return HEADER
    if _is_tracked(text):
        return HEADER if y0 < page_h / 2 else FOOTER
    # Type set smaller than the narrative: footnotes, endnotes, source lists,
    # exhibit tables. None of it reads well aloud.
    if size <= body_size - FOOTNOTE_SIZE_DELTA:
        return FOOTNOTE
    return BODY


def _is_tracked(text: str) -> bool:
    """True for letter-spaced display type, which extracts as lone characters.

    Digits count toward the share so tracked dates ("J U N E 2 2 , 2 0 2 4")
    register, but a few real letters are required as well -- otherwise an
    exhibit table row of single digits would look like a tracked heading.
    """
    tokens = text.split()
    if len(tokens) < TRACKED_MIN_TOKENS:
        return False
    lone = [t for t in tokens if len(t) == 1 and t.isalnum()]
    letters = sum(1 for t in lone if t.isalpha())
    return (len(lone) >= TRACKED_SHARE * len(tokens)
            and letters >= TRACKED_MIN_LETTERS)


def _signature(text: str) -> str:
    """Collapse digits and whitespace so 'Page 3' and 'Page 4' compare equal."""
    return re.sub(r"\d+", "#", " ".join(text.split())).strip().lower()


def _running_signatures(lines: list[dict], geom: list[tuple[float, float]]) -> set[str]:
    """Signatures that recur in the head/foot band across enough pages."""
    seen: dict[str, set[int]] = {}
    for ln in lines:
        page_h = geom[ln["page"]][1]
        y0, y1 = ln["bbox"][1], ln["bbox"][3]
        if y1 <= page_h * TOP_BAND or y0 >= page_h * BOT_BAND:
            seen.setdefault(_signature(ln["text"]), set()).add(ln["page"])
    threshold = max(RUNNING_MIN_PAGES, round(len(geom) * RUNNING_MIN_FRACTION))
    return {sig for sig, pages in seen.items() if len(pages) >= threshold}


def _body_size(lines: list[dict]) -> float:
    """Most common font size, weighted by how much text is set in it."""
    tally: Counter[float] = Counter()
    for ln in lines:
        tally[round(ln["size"] * 2) / 2] += ln["weight"]
    return tally.most_common(1)[0][0] if tally else 0.0


def _strip_superscripts(chars: list[dict]) -> list[dict]:
    """Drop superscript reference markers, keeping ordinal suffixes.

    Footnote markers extract fused onto their neighbour ('anniversarya',
    'gas.2,3') so they have to go character by character rather than by word.
    An ordinal's suffix is also superscript, and dropping it would turn
    '70th' into '70' -- read aloud as "seventy" instead of "seventieth".
    """
    kept: list[dict] = []
    i = 0
    while i < len(chars):
        if not chars[i]["sup"]:
            kept.append(chars[i])
            i += 1
            continue
        run = i
        while run < len(chars) and chars[run]["sup"]:
            run += 1
        text = "".join(c["c"] for c in chars[i:run]).strip().lower()
        prev = kept[-1]["c"] if kept else ""
        if text in ORDINAL_SUFFIXES and prev.isdigit():
            kept.extend(chars[i:run])
        i = run
    return kept


def _words_from_chars(line: dict) -> list[LayoutWord]:
    """Split a line's characters into words, dropping superscript markers.

    The box spans only the characters that survive, so a highlight never
    reaches out over a dropped marker.
    """
    words: list[LayoutWord] = []
    pending: list[dict] = []

    def flush() -> None:
        kept = _strip_superscripts(pending)
        pending.clear()
        text = "".join(c["c"] for c in kept).strip()
        if not text:
            return
        boxes = [c["bbox"] for c in kept]
        words.append(LayoutWord(
            text=text, page=line["page"], kind=line["kind"],
            bbox=(min(b[0] for b in boxes), min(b[1] for b in boxes),
                  max(b[2] for b in boxes), max(b[3] for b in boxes)),
            block=line["block"], line=line["line"],
        ))

    for ch in line["chars"]:
        if ch["c"].isspace():
            flush()
        else:
            pending.append(ch)
    flush()
    return words


def extract_layout(path: str | Path) -> PdfLayout:
    """Extract every word with its page box and a body/furniture classification."""
    import fitz  # pymupdf

    doc = fitz.open(str(path))
    try:
        geom: list[tuple[float, float]] = []
        lines: list[dict] = []
        for pno, page in enumerate(doc):
            geom.append((page.rect.width, page.rect.height))
            # rawdict gives per-character boxes and per-span flags, so word
            # boxes and superscript detection come from one pass.
            for block_no, block in enumerate(page.get_text("rawdict").get("blocks", [])):
                if block.get("type") != 0:  # 0 = text; skip images
                    continue
                for line_no, line in enumerate(block.get("lines", [])):
                    chars: list[dict] = []
                    body_sizes: list[float] = []
                    for span in line.get("spans", []):
                        sup = bool(span.get("flags", 0) & 1)  # bit 0 = superscript
                        size = span.get("size", 0.0)
                        if not sup:
                            body_sizes.append(size)
                        for ch in span.get("chars", []):
                            chars.append({"c": ch["c"], "bbox": tuple(ch["bbox"]),
                                          "sup": sup})
                    text = "".join(c["c"] for c in chars).strip()
                    if not text:
                        continue
                    lines.append({
                        "page": pno, "block": block_no, "line": line_no,
                        "bbox": tuple(line["bbox"]), "text": text, "chars": chars,
                        # Judge size on normal type; a marker shouldn't make a
                        # body line look like a footnote or vice versa.
                        "size": max(body_sizes, default=0.0),
                        "weight": len(text),
                    })
    finally:
        doc.close()

    body = _body_size(lines)
    running = _running_signatures(lines, geom)
    words: list[LayoutWord] = []
    for ln in lines:
        ln["kind"] = _line_kind(ln, geom[ln["page"]][1], body, running)
        words.extend(_words_from_chars(ln))
    return PdfLayout(pages=geom, words=words)


def _line_bbox(line: list[LayoutWord]) -> tuple[float, float, float, float]:
    return (
        min(w.bbox[0] for w in line),
        min(w.bbox[1] for w in line),
        max(w.bbox[2] for w in line),
        max(w.bbox[3] for w in line),
    )


def _group_lines(words: list[LayoutWord]) -> list[list[LayoutWord]]:
    """Group a run into visual lines, in stream order."""
    lines: list[list[LayoutWord]] = []
    for w in words:
        key = (w.page, w.block, w.line)
        if not lines or (lines[-1][0].page, lines[-1][0].block, lines[-1][0].line) != key:
            lines.append([w])
        else:
            lines[-1].append(w)
    return lines


def _typical_leading(lines: list[list[LayoutWord]]) -> float:
    """Median gap between stacked lines, ignoring paragraph-sized jumps."""
    heights = [_line_bbox(ln)[3] - _line_bbox(ln)[1] for ln in lines]
    median_h = sorted(heights)[len(heights) // 2] if heights else 12.0
    gaps: list[float] = []
    for a, b in zip(lines, lines[1:]):
        if a[0].page != b[0].page:
            continue
        dy = _line_bbox(b)[1] - _line_bbox(a)[1]
        if 1 < dy <= median_h * 2.2:
            gaps.append(dy)
    if gaps:
        gaps.sort()
        return gaps[len(gaps) // 2]
    return max(median_h * 1.15, 1.0)


def _wrapped(prev: list[LayoutWord], nxt: list[LayoutWord], leading: float) -> bool:
    """True when nxt continues prev's paragraph rather than starting a new one.

    Same PDF block is always a wrap (pymupdf already grouped the lines).
    Different blocks still wrap when they're stacked at ordinary line spacing
    -- print-to-PDF and many news articles emit each visual line as its own
    block, and treating that as a paragraph made TTS pause at every wrap.
    """
    if prev[0].page == nxt[0].page and prev[0].block == nxt[0].block:
        return True
    if prev[0].page != nxt[0].page:
        last = prev[-1].text.rstrip()
        return bool(last) and last[-1] not in ".!?:;"
    dy = _line_bbox(nxt)[1] - _line_bbox(prev)[1]
    if dy <= 1:
        return False  # side-by-side, not a line below
    return dy <= leading * WRAP_LEADING


def _run_text(words: list[LayoutWord], leading: float | None = None) -> str:
    """Join a run of words, breaking only at real paragraph gaps.

    Visual line wraps stay one sentence even when the PDF put each line in
    its own block. A larger gap (or a page break after end punctuation) is
    treated as a paragraph so headings and new sections still split.

    `leading` is the document's typical body line spacing. Passing it in
    keeps a short run (a title, a dek) from treating its own extra space
    as the wrap interval and gluing onto the next paragraph.
    """
    lines = _group_lines(words)
    if not lines:
        return ""
    if leading is None:
        leading = _typical_leading(lines)
    parts: list[str] = [" ".join(w.text for w in lines[0])]
    for prev, nxt in zip(lines, lines[1:]):
        parts.append(" " if _wrapped(prev, nxt, leading) else "\n\n")
        parts.append(" ".join(w.text for w in nxt))
    return "".join(parts)


def build_layout_document(title: str, layout: PdfLayout) -> Document:
    """Chunk a PDF into sentences carrying page boxes and a body/furniture kind.

    Runs of the same kind are chunked separately. The chunker merges short
    sentences into their neighbours, so chunking everything together would let
    a running header glue itself onto the first line of prose and get read.
    """
    doc = Document(title=title, pages=list(layout.pages))
    body_lines = _group_lines([w for w in layout.words if w.kind == BODY])
    leading = _typical_leading(body_lines)
    for run in _runs(layout.words):
        cursor = 0
        for text in chunk_sentences(split_sentences(_run_text(run, leading))):
            toks = tokenize(text)
            boxes: list[tuple[int, float, float, float, float]] = []
            for tok, _, _ in toks:
                cursor, src = _consume(run, cursor, tok)
                boxes.append((src.page, *src.bbox) if src else (run[0].page, 0, 0, 0, 0))
            doc.sentences.append(Sentence(
                id=len(doc.sentences), text=text,
                words=[Word(t, s, e) for t, s, e in toks],
                kind=run[0].kind, boxes=boxes,
            ))
    return doc


def _runs(words: list[LayoutWord]) -> list[list[LayoutWord]]:
    """Split the word stream into consecutive same-kind runs."""
    runs: list[list[LayoutWord]] = []
    for w in words:
        if runs and runs[-1][0].kind == w.kind:
            runs[-1].append(w)
        else:
            runs.append([w])
    return runs


def _consume(run: list[LayoutWord], cursor: int, token: str) -> tuple[int, LayoutWord | None]:
    """Match a chunk token to the next source word, resyncing if they diverge.

    Chunking is near-lossless but can hard-split a pathologically long token,
    so rather than trusting a 1:1 walk we re-anchor on the token's text.
    """
    if cursor >= len(run):
        return cursor, None
    if run[cursor].text == token:
        return cursor + 1, run[cursor]
    for probe in range(cursor, min(cursor + 8, len(run))):
        if token.startswith(run[probe].text) or run[probe].text.startswith(token):
            return probe + 1, run[probe]
    return cursor + 1, run[cursor]
