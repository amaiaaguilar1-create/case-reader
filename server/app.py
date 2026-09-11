"""LocalSpeech server.

One process, three responsibilities:
- library persistence (SQLite: documents, sentences, positions)
- chunk synthesis endpoint with a single-worker prefetch queue (Kokoro is
  serialized anyway; one worker keeps ordering strictly play-ahead)
- static serving of the web app
"""
from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from core.chunker import build_document
from core.parsers import PARSERS, ScannedPDFError
from engines.kokoro_engine import DEFAULT_PRESET, KokoroEngine

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "localspeech.db"
PREFETCH_AHEAD = 3

app = FastAPI(title="LocalSpeech")
engine: KokoroEngine | None = None
_prefetch = ThreadPoolExecutor(max_workers=1)
_inflight: set[tuple[int, int, str]] = set()
_inflight_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS documents(
            id INTEGER PRIMARY KEY, title TEXT NOT NULL,
            created REAL DEFAULT (unixepoch()), position INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS sentences(
            doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            sent_id INTEGER NOT NULL, text TEXT NOT NULL, words TEXT NOT NULL,
            PRIMARY KEY(doc_id, sent_id));
        """)


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


def _store(title: str, text: str) -> dict:
    doc = build_document(title, text)
    if not doc.sentences:
        raise HTTPException(422, "No readable text found in this document.")
    with db() as c:
        cur = c.execute("INSERT INTO documents(title) VALUES(?)", (title,))
        doc_id = cur.lastrowid
        c.executemany(
            "INSERT INTO sentences VALUES(?,?,?,?)",
            [(doc_id, s.id, s.text,
              json.dumps([[w.text, w.start, w.end] for w in s.words]))
             for s in doc.sentences])
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
    except ScannedPDFError:
        raise HTTPException(422, "This PDF has no extractable text. "
                                 "It looks scanned; OCR isn't supported yet.")
    finally:
        tmp_path.unlink(missing_ok=True)
    title = Path(file.filename or "Untitled").stem
    return _store(title, parsed.full_text)


@app.post("/api/documents/text")
def import_text(body: TextImport):
    return _store(body.title.strip() or "Pasted text", body.text)


@app.post("/api/documents/url")
def import_url(body: UrlImport):
    import trafilatura
    html = trafilatura.fetch_url(body.url)
    text = trafilatura.extract(html) if html else None
    if not text:
        raise HTTPException(422, "Couldn't extract an article from that URL.")
    meta = trafilatura.extract_metadata(html)
    title = (meta.title if meta and meta.title else body.url)[:120]
    return _store(title, text)


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: int):
    with db() as c:
        doc = c.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "Document not found")
        rows = c.execute("SELECT sent_id, text, words FROM sentences "
                         "WHERE doc_id=? ORDER BY sent_id", (doc_id,)).fetchall()
    return {"id": doc["id"], "title": doc["title"], "position": doc["position"],
            "sentences": [{"id": r["sent_id"], "text": r["text"],
                           "words": json.loads(r["words"])} for r in rows]}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int):
    with db() as c:
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    return {"ok": True}


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


def _sentence(doc_id: int, sent_id: int) -> sqlite3.Row:
    with db() as c:
        row = c.execute("SELECT text, words FROM sentences WHERE doc_id=? AND sent_id=?",
                        (doc_id, sent_id)).fetchone()
    if not row:
        raise HTTPException(404, "Chunk not found")
    return row


def _synth(doc_id: int, sent_id: int, voice: str):
    from core.model import Word
    row = _sentence(doc_id, sent_id)
    words = [Word(t, s, e) for t, s, e in json.loads(row["words"])]
    return engine.synthesize(row["text"], words, voice)


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
    result = _synth(doc_id, sent_id, voice)
    for ahead in range(1, PREFETCH_AHEAD + 1):
        key = (doc_id, sent_id + ahead, voice)
        with _inflight_lock:
            if key in _inflight:
                continue
            _inflight.add(key)
        _prefetch.submit(_prefetch_one, *key)
    return {"audio": f"/api/audio/{result.wav_path.name}",
            "duration": result.duration,
            "timings": result.word_timings}


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
