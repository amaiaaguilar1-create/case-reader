"""Layout extraction: furniture classification and word-box alignment."""
import pytest

from core.layout import (BODY, BOILERPLATE, FOOTNOTE, FURNITURE,
                         build_layout_document, extract_layout, _is_tracked,
                         _strip_superscripts, _words_from_chars)

fitz = pytest.importorskip("fitz")

PAGE_W, PAGE_H = 612.0, 792.0
BODY_TEXT = ("Robert took the helm of the family business in 2009. "
             "The board met each quarter to review the succession plan. "
             "Revenue grew steadily through the following decade. ")


@pytest.fixture(scope="module")
def sample_pdf(tmp_path_factory):
    """A three-page PDF with a running head, page numbers, and a footnote."""
    path = tmp_path_factory.mktemp("pdf") / "sample.pdf"
    doc = fitz.open()
    for n in range(3):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        page.insert_text((72, 40), "From Beirut With Love (A)", fontsize=9)
        page.insert_textbox(fitz.Rect(72, 110, 540, 400), BODY_TEXT * 3, fontsize=11)
        page.insert_text((72, 700), "1 A small note on the exhibit.", fontsize=7)
        page.insert_text((300, 760), str(n + 1), fontsize=9)
    doc.save(str(path))
    doc.close()
    return path


@pytest.mark.parametrize("text, tracked", [
    ("R E V : N O V E M B E R 1 , 2 0 1 8", True),
    ("J U N E 2 2 , 2 0 2 4", True),
    ("C H R I S T I N A R . W I N G", True),
    ("1 2 3 4 5", False),                       # exhibit row, not a heading
    ("A 1 2 3 4", False),                       # one stray letter isn't tracking
    ("2019 2020 2021 2022", False),
    ("He said it was a big deal", False),
    ("R E V", False),                           # too short to judge
])
def test_is_tracked(text, tracked):
    assert _is_tracked(text) is tracked


def _chars(text, superscript=""):
    """Char dicts for `text`, with the trailing `superscript` tail flagged."""
    out = []
    for i, c in enumerate(text + superscript):
        out.append({"c": c, "sup": i >= len(text),
                    "bbox": (i * 5.0, 100.0, i * 5.0 + 5, 110.0)})
    return out


@pytest.mark.parametrize("word, tail, expected", [
    ("anniversary", "a", "anniversary"),   # footnote marker fused onto a word
    ("gas.", "2,3", "gas."),               # multiple markers plus separator
    ("journey.", "17", "journey."),
    ("70", "th", "70th"),                  # ordinal suffix belongs to the number
    ("1", "st", "1st"),
    ("22", "nd", "22nd"),
    ("Group", "", "Group"),                # nothing to strip
    ("Nuqul", "b", "Nuqul"),
])
def test_strip_superscripts(word, tail, expected):
    kept = _strip_superscripts(_chars(word, tail))
    assert "".join(c["c"] for c in kept) == expected


def test_lone_marker_produces_no_word():
    """A marker standing alone leaves nothing to read or highlight."""
    line = {"page": 0, "block": 0, "line": 0, "kind": BODY,
            "chars": _chars("", "12")}
    assert _words_from_chars(line) == []


def test_box_excludes_dropped_marker():
    """The highlight must not stretch over a marker that isn't read."""
    line = {"page": 0, "block": 0, "line": 0, "kind": BODY,
            "chars": _chars("anniversary", "a")}
    word, = _words_from_chars(line)
    assert word.text == "anniversary"
    assert word.bbox[2] == pytest.approx(len("anniversary") * 5.0)


def test_classifies_page_furniture(sample_pdf):
    layout = extract_layout(sample_pdf)
    assert len(layout.pages) == 3
    assert layout.pages[0] == pytest.approx((PAGE_W, PAGE_H))

    kinds = {}
    for w in layout.words:
        kinds.setdefault(w.kind, set()).add(w.text)

    assert "Beirut" in kinds.get("header", set()), "running head not detected"
    assert "1" in kinds.get("footer", set()), "page number not detected"
    assert "exhibit." in kinds.get(FOOTNOTE, set()), "small low type not a footnote"
    assert "succession" in kinds.get(BODY, set()), "prose must stay readable"


def test_boilerplate_beats_position(sample_pdf):
    """Licensing text is furniture wherever it sits on the page."""
    path = sample_pdf.parent / "boiler.pdf"
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_textbox(fitz.Rect(72, 300, 540, 360),
                        "Copyright \u00a9 2018 President and Fellows of Harvard College.",
                        fontsize=11)
    doc.save(str(path))
    doc.close()
    assert {w.kind for w in extract_layout(path).words} == {BOILERPLATE}


def test_every_word_gets_a_box(sample_pdf):
    doc = build_layout_document("sample", extract_layout(sample_pdf))
    assert doc.sentences
    for s in doc.sentences:
        assert len(s.boxes) == len(s.words), f"box/word mismatch in {s.id}"
    body = [s for s in doc.sentences if s.kind == BODY]
    assert body, "no readable sentences survived"
    for page, x0, y0, x1, y1 in body[0].boxes:
        assert 0 <= page < 3
        assert x1 > x0 and y1 > y0, "body words need a real rectangle to highlight"
        assert x1 <= PAGE_W and y1 <= PAGE_H


def test_small_type_is_a_note_anywhere_on_the_page(sample_pdf):
    """Endnotes and source lists start at the top of their own page."""
    path = sample_pdf.parent / "endnotes.pdf"
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_textbox(fitz.Rect(72, 90, 540, 300), BODY_TEXT * 2, fontsize=10)
    doc.new_page(width=PAGE_W, height=PAGE_H).insert_textbox(
        fitz.Rect(72, 60, 540, 300),
        "Al Sayegh, Hadeel. Affirma Capital seeks to sell a stake. Reuters, 2021. ",
        fontsize=8)
    doc.save(str(path))
    doc.close()
    kinds = {}
    for w in extract_layout(path).words:
        kinds.setdefault(w.kind, set()).add(w.text)
    assert "Reuters," in kinds.get(FOOTNOTE, set()), "8pt citation should be a note"
    assert "succession" in kinds.get(BODY, set()), "10pt narrative stays readable"


def test_furniture_never_merges_into_prose(sample_pdf):
    """The chunker merges short sentences; runs must keep kinds from mixing."""
    doc = build_layout_document("sample", extract_layout(sample_pdf))
    for s in doc.sentences:
        assert s.kind in FURNITURE | {BODY}
    readable = " ".join(s.text for s in doc.sentences if s.kind == BODY)
    assert "From Beirut With Love" not in readable
    assert "A small note" not in readable
    assert "succession plan" in readable
