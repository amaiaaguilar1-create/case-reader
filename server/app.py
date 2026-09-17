"""LocalSpeech server.

One process, three responsibilities:
- library persistence (SQLite: documents, sentences, positions)
- chunk synthesis endpoint with a single-worker prefetch queue (Kokoro is
  serialized anyway; one worker keeps ordering strictly play-ahead)
- static serving of the web app
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from core.chunker import PACK_LOOKAHEAD, build_document, pack_for_speech
from core.model import Document, Word
from core.parsers import PARSERS, ScannedPDFError
from engines.kokoro_engine import DEFAULT_PRESET, KokoroEngine

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "localspeech.db"
LIBRARY = ROOT / "library"          # originals, kept so pages can be re-rendered
PAGE_CACHE = ROOT / "cache" / "pages"
PREFETCH_AHEAD = 1               # next pack; more than that re-synthesizes overlapping windows
RENDER_SCALE = 2.0                  # 2x keeps page text crisp on retina displays

app = FastAPI(title="LocalSpeech")
engine: KokoroEngine | None = None
_prefetch = ThreadPoolExecutor(max_workers=1)
_inflight: set[tuple[int, int, str]] = set()
_inflight_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


#: Columns added after the first release; applied to existing libraries in place.
_MIGRATIONS = {
    "documents": {"source_ext": "TEXT", "pages": "TEXT"},
    "sentences": {"kind": "TEXT NOT NULL DEFAULT 'body'", "boxes": "TEXT NOT NULL DEFAULT '[]'"},
}


def init_db() -> None:
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS documents(
            id INTEGER PRIMARY KEY, title TEXT NOT NULL,
            created REAL DEFAULT (unixepoch()), position INTEGER DEFAULT 0,
            source_ext TEXT, pages TEXT);
        CREATE TABLE IF NOT EXISTS sentences(
            doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            sent_id INTEGER NOT NULL, text TEXT NOT NULL, words TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'body', boxes TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY(doc_id, sent_id));
        """)
        for table, columns in _MIGRATIONS.items():
            have = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            for name, ddl in columns.items():
                if name not in have:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    LIBRARY.mkdir(exist_ok=True)
    PAGE_CACHE.mkdir(parents=True, exist_ok=True)


@app.on_event("startup")
def startup() -> None:
    global engine
    init_db()
    fp32, int8 = ROOT / "kokoro-v1.0.onnx", ROOT / "kokoro-v1.0.int8.onnx"
    model = fp32 if fp32.exists() else int8
    if model == int8:
        # int8 is voice/text-unstable (validated): blends explode, some solo
        # voices collapse to near-silence. fp32 is the supported default.
        print("WARNING: running on int8 model; voice quality is unreliable. "
              "Run scripts/download_model.sh to fetch the fp32 model.")
    engine = KokoroEngine(str(model), str(ROOT / "voices-v1.0.bin"),
                          cache_dir=str(ROOT / "cache"))


# ---------- library ----------

class TextImport(BaseModel):
    title: str
    text: str


class UrlImport(BaseModel):
    url: str


def _store(title: str, doc: Document, source: Path | None = None, ext: str = "") -> dict:
    if not doc.sentences:
        raise HTTPException(422, "No readable text found in this document.")
    with db() as c:
        cur = c.execute("INSERT INTO documents(title, source_ext, pages) VALUES(?,?,?)",
                        (title, ext or None,
                         json.dumps(doc.pages) if doc.pages else None))
        doc_id = cur.lastrowid
        c.executemany(
            "INSERT INTO sentences(doc_id,sent_id,text,words,kind,boxes) VALUES(?,?,?,?,?,?)",
            [(doc_id, s.id, s.text,
              json.dumps([[w.text, w.start, w.end] for w in s.words]),
              s.kind, json.dumps(s.boxes))
             for s in doc.sentences])
    # Keep the original only when it has pages we can render alongside the text.
    if source and doc.pages:
        shutil.copyfile(source, LIBRARY / f"{doc_id}{ext}")
    return {"id": doc_id, "title": title, "sentences": len(doc.sentences)}


@app.get("/api/documents")
def list_documents():
    with db() as c:
        rows = c.execute("""SELECT d.id, d.title, d.position, d.created,
                                   COUNT(s.sent_id) AS total
                            FROM documents d LEFT JOIN sentences s ON s.doc_id=d.id
                            GROUP BY d.id ORDER BY d.created DESC""").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/documents/file")
async def import_file(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in PARSERS:
        raise HTTPException(415, f"Unsupported format {ext or '(none)'}. "
                                 f"Supported: {', '.join(sorted(PARSERS))}")
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)
    try:
        parsed = PARSERS[ext](tmp_path)
        title = Path(file.filename or "Untitled").stem
        return _store(title, parsed, source=tmp_path, ext=ext)
    except ScannedPDFError:
        raise HTTPException(422, "This PDF has no extractable text. "
                                 "It looks scanned; OCR isn't supported yet.")
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/api/documents/text")
def import_text(body: TextImport):
    title = body.title.strip() or "Pasted text"
    return _store(title, build_document(title, body.text))


@app.post("/api/documents/url")
def import_url(body: UrlImport):
    import trafilatura
    html = trafilatura.fetch_url(body.url)
    text = trafilatura.extract(html) if html else None
    if not text:
        raise HTTPException(422, "Couldn't extract an article from that URL.")
    meta = trafilatura.extract_metadata(html)
    title = (meta.title if meta and meta.title else body.url)[:120]
    return _store(title, build_document(title, text))


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: int):
    with db() as c:
        doc = c.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "Document not found")
        rows = c.execute("SELECT sent_id, text, words, kind, boxes FROM sentences "
                         "WHERE doc_id=? ORDER BY sent_id", (doc_id,)).fetchall()
    return {"id": doc["id"], "title": doc["title"], "position": doc["position"],
            "pages": json.loads(doc["pages"]) if doc["pages"] else [],
            "sentences": [{"id": r["sent_id"], "text": r["text"],
                           "words": json.loads(r["words"]), "kind": r["kind"],
                           "boxes": json.loads(r["boxes"])} for r in rows]}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int):
    with db() as c:
        c.execute("PRAGMA foreign_keys=ON")
        row = c.execute("SELECT source_ext FROM documents WHERE id=?", (doc_id,)).fetchone()
        c.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    if row and row["source_ext"]:
        (LIBRARY / f"{doc_id}{row['source_ext']}").unlink(missing_ok=True)
    for png in PAGE_CACHE.glob(f"{doc_id}-*.png"):
        png.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/page/{doc_id}/{page_no}")
def get_page(doc_id: int, page_no: int):
    """Render one page of the stored original, cached as PNG."""
    with db() as c:
        row = c.execute("SELECT source_ext FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    if not row["source_ext"]:
        raise HTTPException(404, "No original page image for this document.")
    src = LIBRARY / f"{doc_id}{row['source_ext']}"
    if not src.exists():
        raise HTTPException(404, "The original file is no longer on disk.")
    out = PAGE_CACHE / f"{doc_id}-{page_no}@{RENDER_SCALE:g}.png"
    if not out.exists():
        import fitz
        pdf = fitz.open(str(src))
        try:
            if not 0 <= page_no < pdf.page_count:
                raise HTTPException(404, "Page out of range")
            pix = pdf[page_no].get_pixmap(matrix=fitz.Matrix(RENDER_SCALE, RENDER_SCALE))
            tmp = out.with_suffix(".tmp.png")  # atomic: concurrent readers see whole files
            pix.save(str(tmp))
            tmp.replace(out)
        finally:
            pdf.close()
    return FileResponse(out, media_type="image/png",
                        headers={"Cache-Control": "private, max-age=86400"})


class Position(BaseModel):
    sentence: int


@app.put("/api/documents/{doc_id}/position")
def save_position(doc_id: int, body: Position):
    with db() as c:
        c.execute("UPDATE documents SET position=? WHERE id=?", (body.sentence, doc_id))
    return {"ok": True}


# ---------- synthesis ----------

@app.get("/api/voices")
def voices():
    assert engine
    return [{"id": p.id, "label": p.label} for p in engine.presets()]


def _synth(doc_id: int, sent_id: int, voice: str):
    with db() as c:
        rows = c.execute(
            "SELECT sent_id, kind, text, words FROM sentences "
            "WHERE doc_id=? AND sent_id>=? ORDER BY sent_id LIMIT ?",
            (doc_id, sent_id, PACK_LOOKAHEAD)).fetchall()
    if not rows or rows[0]["sent_id"] != sent_id:
        raise HTTPException(404, "Chunk not found")
    packed = pack_for_speech(
        [(r["sent_id"], r["kind"], r["text"]) for r in rows])
    by_id = {r["sent_id"]: r for r in rows}
    texts: list[str] = []
    words: list[Word] = []
    parts: list[dict] = []
    for sid in packed:
        r = by_id[sid]
        w = [Word(t, s, e) for t, s, e in json.loads(r["words"])]
        texts.append(r["text"])
        words.extend(w)
        parts.append({"id": sid, "words": len(w)})
    result = engine.synthesize(" ".join(texts), words, voice)
    return result, parts


def _prefetch_one(doc_id: int, sent_id: int, voice: str) -> None:
    key = (doc_id, sent_id, voice)
    try:
        _synth(doc_id, sent_id, voice)
    except HTTPException:
        pass  # past end of document
    finally:
        with _inflight_lock:
            _inflight.discard(key)


@app.get("/api/chunk/{doc_id}/{sent_id}")
def get_chunk(doc_id: int, sent_id: int, voice: str = DEFAULT_PRESET):
    assert engine
    result, parts = _synth(doc_id, sent_id, voice)
    through = parts[-1]["id"]
    for ahead in range(1, PREFETCH_AHEAD + 1):
        key = (doc_id, through + ahead, voice)
        with _inflight_lock:
            if key in _inflight:
                continue
            _inflight.add(key)
        _prefetch.submit(_prefetch_one, *key)
    return {"audio": f"/api/audio/{result.wav_path.name}",
            "duration": result.duration,
            "timings": result.word_timings,
            "parts": parts}


@app.get("/api/audio/{name}")
def get_audio(name: str):
    path = (ROOT / "cache" / name).resolve()
    if path.parent != (ROOT / "cache").resolve() or not path.exists():
        raise HTTPException(404, "Audio not found")
    return FileResponse(path, media_type="audio/wav")


# ---------- static ----------

@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")


@app.exception_handler(Exception)
async def unhandled(request, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)})
