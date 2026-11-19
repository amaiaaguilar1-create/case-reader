"""Build the PDF that sample mode opens.

    .venv/bin/python scripts/make_sample_pdf.py

Writes site/src/sample/hollis-street-bakery.pdf. The PDF is committed, so the
site build never needs Python; run this again only after changing the text.

Every word here was written for Case Reader. The bakery, its people and its
numbers are invented, and nothing is taken from a published case or article.

The page is laid out to show what the reader does with a real case PDF:

- a running head on both pages and a page number at the foot of each, which
  the reader shows but does not read;
- footnotes, a source note and a small exhibit table, set in smaller type and
  skipped for the same reason, with raised reference markers in the prose
  that are dropped rather than read out as numbers;
- paragraphs that wrap across several lines, which have to be heard as whole
  sentences and highlighted line by line on the page.

The fonts are the standard PDF Times and Helvetica, referenced rather than
embedded, so the file carries no font data and stays a few kilobytes.
"""
from pathlib import Path

import pymupdf

OUT = (Path(__file__).resolve().parent.parent
       / "site" / "src" / "sample" / "hollis-street-bakery.pdf")

PAGE_W, PAGE_H = 612, 792
LEFT, RIGHT = 72, 540

SERIF, SERIF_BOLD = "tiro", "tibo"
SANS, SANS_BOLD = "helv", "hebo"
GREY = (0.38, 0.38, 0.38)

BODY_SIZE, BODY_LEADING, PARA_GAP = 12, 17, 9
NOTE_SIZE, NOTE_LEADING, NOTE_GAP = 8.5, 11, 4
# Reference markers: small and raised, the way a typesetter sets them.
MARK_SIZE, MARK_RISE = 7, 4.5
NOTE_MARK_SIZE, NOTE_MARK_RISE = 6, 3

TITLE = "Should Hollis Street Bakery Buy a Second Oven?"

# A caret marks a footnote reference: "sell.^1" sets a raised 1 after "sell."
PAGE_ONE = [
    "On a wet Tuesday in March, Rosa Okafor stood at the back of Hollis Street "
    "Bakery and listened to the oven tick as it cooled. She had opened the shop "
    "in 2019 with one deck oven, two mixers, and a lease she could only just "
    "afford. Six years later the Saturday line ran past the hardware store next "
    "door, and it was the oven, not the customers, that capped what she could "
    "sell.^1",

    "The question in front of her was easy to state and hard to answer. A "
    "second oven would cost $38,000 installed, and it would roughly double "
    "what the kitchen could bake before the doors opened at seven. But extra "
    "bread is only worth baking if someone buys it, and Rosa was not sure that "
    "the people who queued on Saturday would come back on a Wednesday.",

    "Her head baker, Tomás Reyes, thought the answer was wholesale. Three "
    "cafés within walking distance had asked, more than once, whether the "
    "bakery could supply their morning pastries. Each wanted about forty "
    "pieces a day, delivered by half past six, and each expected about a third "
    "off the counter price.^2 Tomás argued that a standing order was the "
    "steadiest money a bakery could hope for: the same order every morning, "
    "paid on the first of the month.",

    "Rosa's bookkeeper, June Albright, was less sure. A third off the counter "
    "price left very little once flour, butter, and the bakers' early hours "
    "were paid for. And in June's experience, a café that came to depend on a "
    "supplier soon started asking for longer payment terms. In her view the "
    "oven had to earn its keep at the counter, or not at all.",
]

PAGE_TWO = [
    "There was a third path that nobody liked to say out loud. The bakery could "
    "keep its one oven, raise its prices, and let the Saturday line grow a "
    "little shorter. Rosa had watched two other shops on the street try it, "
    "with mixed results.^3",

    "By the time the oven had gone quiet, she had written down what she needed "
    "to know. How many loaves did the counter really sell on a weekday? What "
    "would the cafés actually pay, and for how long? And could Tomás run two "
    "ovens and still be home for dinner? The decision could wait a week. The "
    "numbers could not.",
]

SOURCE_NOTE = ("Written for the Case Reader sample. Hollis Street Bakery, its "
               "people and every figure here are invented.")

NOTES_ONE = [
    ("1", "Average daily sales are in Exhibit 1. On a typical Saturday the "
          "bakery sold almost three times what it sold on a weekday."),
    ("2", "The cafés made their offers in conversation, not in writing, and "
          "none of them had said how long it would keep ordering."),
]

NOTES_TWO = [
    ("3", "Like the running head at the top of each page and the page number at "
          "the bottom, this note is printed to be seen, not heard. Case Reader "
          "shows it on the page and skips it when reading aloud."),
]

EXHIBIT_TITLE = "Exhibit 1    Average items sold per day, January and February"
EXHIBIT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
EXHIBIT_ROWS = [
    ("Bread", [96, 88, 91, 104, 140, 310, 220]),
    ("Pastry", [150, 142, 147, 160, 210, 410, 300]),
    ("Total", [246, 230, 238, 264, 350, 720, 520]),
]


def width(text, font, size):
    return pymupdf.get_text_length(text, fontname=font, fontsize=size)


def put(page, x, y, text, font, size, color=(0, 0, 0)):
    """One text object. Separate objects are what pdf.js hands back as items."""
    page.insert_text((x, y), text, fontname=font, fontsize=size, color=color)


def lines_of(text, font, size, measure, mark_size):
    """Greedy word wrap. Each line is a list of (word, marker) pairs."""
    space = width(" ", font, size)
    lines, line, used = [], [], 0.0
    for token in text.split():
        word, _, mark = token.partition("^")
        w = width(word, font, size) + (width(mark, font, mark_size) if mark else 0)
        if line and used + space + w > measure:
            lines.append(line)
            line, used = [], 0.0
        used += (space if line else 0) + w
        line.append((word, mark))
    if line:
        lines.append(line)
    return lines


def set_line(page, x, y, line, font, size, mark_size, mark_rise):
    """Set one line, breaking it into separate text objects at each marker."""
    space = width(" ", font, size)
    run = []
    for word, mark in line:
        run.append(word)
        if mark:
            text = " ".join(run)
            put(page, x, y, text, font, size)
            x += width(text, font, size)
            put(page, x, y - mark_rise, mark, font, mark_size)
            x += width(mark, font, mark_size) + space
            run = []
    if run:
        put(page, x, y, " ".join(run), font, size)


def paragraph(page, y, text, font=SERIF, size=BODY_SIZE, leading=BODY_LEADING):
    """Set a body paragraph from baseline `y`; return the next free baseline."""
    for line in lines_of(text, font, size, RIGHT - LEFT, MARK_SIZE):
        set_line(page, LEFT, y, line, font, size, MARK_SIZE, MARK_RISE)
        y += leading
    return y


def note_height(text, indent):
    return len(lines_of(text, SERIF, NOTE_SIZE, RIGHT - LEFT - indent, 0)) * NOTE_LEADING


def notes(page, entries, source=None):
    """Footnotes at the foot of the page, above the page number."""
    indent = 7
    blocks = ([(None, source)] if source else []) + list(entries)
    total = sum(note_height(t, indent if n else 0) for n, t in blocks)
    total += NOTE_GAP * (len(blocks) - 1)
    y = 712 - total + NOTE_LEADING
    page.draw_line((LEFT, y - 14), (LEFT + 144, y - 14), color=GREY, width=0.5)
    for number, text in blocks:
        x = LEFT
        if number:
            put(page, x, y - NOTE_MARK_RISE, number, SERIF, NOTE_MARK_SIZE)
            x += indent
        for line in lines_of(text, SERIF, NOTE_SIZE, RIGHT - x, 0):
            put(page, x, y, " ".join(w for w, _ in line), SERIF, NOTE_SIZE)
            y += NOTE_LEADING
        y += NOTE_GAP


def running_head(page):
    put(page, LEFT, 48, "Hollis Street Bakery", SANS, 8.5, GREY)
    label = "Case Reader sample"
    put(page, RIGHT - width(label, SANS, 8.5), 48, label, SANS, 8.5, GREY)
    page.draw_line((LEFT, 56), (RIGHT, 56), color=GREY, width=0.5)


def page_number(page, n, of):
    label = f"Page {n} of {of}"
    put(page, (PAGE_W - width(label, SANS, 8.5)) / 2, 756, label, SANS, 8.5, GREY)


def exhibit(page, y):
    """A small table, set in note-sized type like the exhibits it stands for."""
    size = 8
    put(page, LEFT, y, EXHIBIT_TITLE, SANS_BOLD, 8.5)
    y += 8
    page.draw_line((LEFT, y), (RIGHT, y), color=GREY, width=0.5)
    y += 12
    cols = [LEFT + 150 + 45 * i for i in range(len(EXHIBIT_DAYS))]

    def row(label, cells, font=SANS):
        put(page, LEFT, y, label, font, size)
        for right, cell in zip(cols, cells):
            text = str(cell)
            put(page, right - width(text, font, size), y, text, font, size)

    row("", EXHIBIT_DAYS, SANS_BOLD)
    y += 5
    page.draw_line((LEFT, y), (RIGHT, y), color=GREY, width=0.3)
    for label, cells in EXHIBIT_ROWS:
        y += 12
        row(label, cells, SANS_BOLD if label == "Total" else SANS)
    y += 6
    page.draw_line((LEFT, y), (RIGHT, y), color=GREY, width=0.5)
    put(page, LEFT, y + 11, "Source: the bakery's till records, as described by "
        "its owner. All figures invented.", SANS, 7)


def build():
    doc = pymupdf.open()

    one = doc.new_page(width=PAGE_W, height=PAGE_H)
    running_head(one)
    put(one, LEFT, 116, TITLE, SERIF_BOLD, 20)
    y = 156
    for text in PAGE_ONE:
        y = paragraph(one, y, text) + PARA_GAP
    notes(one, NOTES_ONE, SOURCE_NOTE)
    page_number(one, 1, 2)

    two = doc.new_page(width=PAGE_W, height=PAGE_H)
    running_head(two)
    y = 104
    for text in PAGE_TWO:
        y = paragraph(two, y, text) + PARA_GAP
    exhibit(two, y + 22)
    notes(two, NOTES_TWO)
    page_number(two, 2, 2)

    doc.set_metadata({
        "title": "Should Hollis Street Bakery Buy a Second Oven?",
        "author": "Case Reader",
        "subject": "An invented two-page case for trying Case Reader",
        "creator": "scripts/make_sample_pdf.py",
        "producer": "PyMuPDF",
        "creationDate": "", "modDate": "",
    })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(OUT), garbage=4, deflate=True, no_new_id=True)
    doc.close()
    print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}"
          f" ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
