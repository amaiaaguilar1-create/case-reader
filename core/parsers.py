"""Extract text from PDF / DOCX / EPUB / TXT into a canonical Document."""
from __future__ import annotations
from pathlib import Path
from .chunker import build_document
from .model import Document


class ScannedPDFError(Exception):
    """Raised when a PDF appears to be image-only (no extractable text)."""


def parse_pdf(path: str | Path) -> Document:
    """Parse a PDF keeping page geometry, word boxes, and furniture labels."""
    from .layout import build_layout_document, extract_layout
    layout = extract_layout(path)
    if not layout.has_text:
        raise ScannedPDFError(f"{path}: no extractable text (scanned/image PDF?)")
    return build_layout_document(Path(path).stem, layout)


def parse_docx(path: str | Path) -> Document:
    import docx
    d = docx.Document(str(path))
    text = "\n\n".join(p.text for p in d.paragraphs if p.text.strip())
    return build_document(Path(path).stem, text)


def parse_epub(path: str | Path) -> Document:
    from ebooklib import epub, ITEM_DOCUMENT
    import re
    book = epub.read_epub(str(path))
    parts = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        html = item.get_content().decode("utf-8", errors="ignore")
        txt = re.sub(r"<[^>]+>", " ", html)
        txt = re.sub(r"\s+", " ", txt).strip()
        if txt:
            parts.append(txt)
    return build_document(Path(path).stem, "\n\n".join(parts))


def parse_txt(path: str | Path) -> Document:
    return build_document(Path(path).stem, Path(path).read_text(errors="replace"))


PARSERS = {".pdf": parse_pdf, ".docx": parse_docx, ".epub": parse_epub,
           ".txt": parse_txt, ".md": parse_txt}


def parse_file(path: str | Path) -> Document:
    ext = Path(path).suffix.lower()
    if ext not in PARSERS:
        raise ValueError(f"Unsupported format: {ext}")
    return PARSERS[ext](path)
