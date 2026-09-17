"""Spoken-form rewrites applied at synthesis, not in the stored document."""
from core.speak import speakable


def test_year_is_read_as_a_year():
    assert speakable("founded in 1978.") == "founded in nineteen seventy eight."
    assert speakable("In 1948 he fled.") == "In nineteen forty eight he fled."
    assert speakable("the 2008 crisis") == "the two thousand eight crisis"
    assert speakable("In 2000, Jordan joined") == "In two thousand, Jordan joined"
    assert speakable("graduated in 2013") == "graduated in twenty thirteen"
    assert speakable("March 2023") == "March twenty twenty three"


def test_decade_and_range():
    assert speakable("during the 1970s") == "during the nineteen seventies"
    assert speakable("the mid-1980s") == "the mid-nineteen eighties"
    assert speakable("the 2000s") == "the two thousands"
    assert speakable("Financials, 2018-2022") == (
        "Financials, twenty eighteen to twenty twenty two"
    )


def test_money_moves_dollars_after_the_scale():
    assert speakable("$1.3 billion") == "1.3 billion dollars"
    assert speakable("$1.3 Billion") == "1.3 billion dollars"
    assert speakable("a $15 billion bid") == "a 15 billion dollars bid"
    assert speakable("worth $11 billion.") == "worth 11 billion dollars."
    assert speakable("$225 million") == "225 million dollars"
    assert speakable("equivalent of $1.41.") == "equivalent of 1.41 dollars."
    assert speakable("it cost $1.") == "it cost 1 dollar."


def test_dotted_acronyms_lose_the_pauses():
    assert speakable("he got an M.B.A. to comply") == "he got an MBA to comply"
    assert speakable("A.J.M. Wheatcroft") == "AJM Wheatcroft"
    assert "United States" in speakable("the U.S. state of Indiana")
    assert "United Kingdom" in speakable("college in the U.K. in 1980")


def test_state_codes_after_a_city():
    out = speakable("LOUISVILLE, Ky.—Each summer")
    assert out.startswith("LOUISVILLE, Kentucky—")
    assert "Ky" not in out
    assert speakable("Boston, MA 02163") == "Boston, Massachusetts 02163"
    # ", In 1978" is a preposition, not Indiana.
    assert "Indiana" not in speakable("returned, In 1978, she left.")


def test_does_not_rewrite_non_years_or_display_noise():
    assert speakable("about 1,500 employees") == "about 1,500 employees"
    assert "dollar" not in speakable("founded in 1978.")
    assert speakable("") == ""
