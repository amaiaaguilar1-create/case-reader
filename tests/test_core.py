import pytest
from core.chunker import split_sentences, chunk_sentences, build_document, MAX_CHARS, MIN_CHARS
from core.timing import estimate_word_timings
from core.model import Word


# ---------- chunker ----------

def test_basic_sentence_split():
    text = "Hello world. This is a test! Does it work? Yes."
    assert split_sentences(text) == ["Hello world.", "This is a test!", "Does it work?", "Yes."]

def test_abbrev_not_oversplit_on_lowercase():
    # splitter requires capital/digit after punctuation, so "e.g. lowercase" survives
    sents = split_sentences("We use models, e.g. small ones, daily. Next sentence here.")
    assert len(sents) == 2

def test_long_sentence_is_split():
    long = ", ".join(["clause number %d with several words" % i for i in range(20)]) + "."
    chunks = chunk_sentences([long])
    assert all(len(c) <= MAX_CHARS for c in chunks)
    assert len(chunks) >= 2

def test_short_sentences_merge():
    chunks = chunk_sentences(["Hi.", "Ok.", "Sure thing."])
    assert len(chunks) == 1

def test_no_content_lost():
    text = "One two three. Four five six seven eight nine ten! Short. " * 5
    doc = build_document("t", text)
    orig_words = text.split()
    doc_words = [w.text for s in doc.sentences for w in s.words]
    assert doc_words == orig_words

def test_word_offsets_valid():
    doc = build_document("t", "The quick brown fox jumps over the lazy dog.")
    for s in doc.sentences:
        for w in s.words:
            assert s.text[w.start:w.end] == w.text

def test_unicode_and_emoji_do_not_crash():
    doc = build_document("t", "Caf\u00e9 r\u00e9sum\u00e9 \ud83d\ude00 na\u00efve \u4e2d\u6587 text here. Second sentence.")
    assert len(doc.sentences) >= 1

def test_empty_input():
    assert build_document("t", "").sentences == []
    assert build_document("t", "   \n\n  ").sentences == []


# ---------- timing ----------

def _mk_words(s):
    import re
    return [Word(m.group(), m.start(), m.end()) for m in re.finditer(r"\S+", s)]

def test_timings_monotonic_and_cover_duration():
    words = _mk_words("The quick brown fox jumps, over the lazy dog.")
    t = estimate_word_timings(words, 3.5)
    assert len(t) == len(words)
    assert t[0][0] == 0.0
    assert abs(t[-1][1] - 3.5) < 1e-9
    for (s1, e1), (s2, e2) in zip(t, t[1:]):
        assert e1 <= s2 + 1e-9 and s1 < e1 and s2 < e2

def test_punctuation_gets_more_time():
    words = _mk_words("word word. word")
    t = estimate_word_timings(words, 3.0)
    dur = [e - s for s, e in t]
    assert dur[1] > dur[0]  # "word." > "word"

def test_empty_words():
    assert estimate_word_timings([], 2.0) == []


# ---------- parsers ----------

def test_pdf_roundtrip(tmp_path):
    import fitz
    pdf = tmp_path / "fixture.pdf"
    d = fitz.open()
    page = d.new_page()
    page.insert_text((72, 72), "This is a PDF fixture. It has two sentences.")
    d.save(str(pdf))
    from core.parsers import parse_pdf
    doc = parse_pdf(pdf)
    assert "PDF fixture" in doc.full_text

def test_scanned_pdf_detected(tmp_path):
    import fitz
    pdf = tmp_path / "blank.pdf"
    d = fitz.open(); d.new_page(); d.save(str(pdf))
    from core.parsers import parse_pdf, ScannedPDFError
    with pytest.raises(ScannedPDFError):
        parse_pdf(pdf)

def test_docx_roundtrip(tmp_path):
    import docx
    f = tmp_path / "fixture.docx"
    d = docx.Document()
    d.add_paragraph("A DOCX fixture paragraph with enough words to matter.")
    d.save(str(f))
    from core.parsers import parse_docx
    assert "DOCX fixture" in parse_docx(f).full_text

def test_unsupported_format(tmp_path):
    from core.parsers import parse_file
    f = tmp_path / "x.xyz"; f.write_text("hi")
    with pytest.raises(ValueError):
        parse_file(f)
