"""Rewrite display text so Kokoro reads it the way a person would.

Applied only at synthesis; the document on screen is unchanged. Kokoro
otherwise reads 1978 as "one thousand nine hundred seventy eight", $1.3
billion as "one dollar point three billion", M.B.A. with a pause at each
period, and KY as the letters K Y.
"""
from __future__ import annotations

import re

_ONES = "zero one two three four five six seven eight nine".split()
_TEENS = ("ten eleven twelve thirteen fourteen fifteen sixteen "
          "seventeen eighteen nineteen").split()
_TENS = ["", "", "twenty", "thirty", "forty", "fifty",
         "sixty", "seventy", "eighty", "ninety"]

# Postal codes after a city: "Louisville, Ky.—" / "Boston, MA 02163".
_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida",
    "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky",
    "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming",
}
_STATE_ALTS = "|".join(sorted(_STATES, key=len, reverse=True))
# Comma + code, then a dateline/zip ending — not ", In 1978".
_STATE_RE = re.compile(
    rf"(,\s*)({_STATE_ALTS})(\.?)(?=(?:[\u2014\u2013,;:\-]|$|\s+\d{{5}}\b|\s*$|\)))",
    re.I,
)
_STATE_PAREN_RE = re.compile(rf"\(({_STATE_ALTS})\)", re.I)

# Longer dotted forms first so U.S.A. doesn't become United States A.
_GEO_DOTTED = (
    (re.compile(r"\bU\.S\.A\."), "United States"),
    (re.compile(r"\bU\.S\."), "United States"),
    (re.compile(r"\bU\.K\."), "United Kingdom"),
    (re.compile(r"\bD\.C\."), "District of Columbia"),
    (re.compile(r"\bPh\.D\."), "PhD"),
)
# M.B.A. / A.J.M. — single letters with a period after each.
_DOTTED_ACRONYM_RE = re.compile(r"\b(?:[A-Z]\.){2,}[A-Z]\.?(?=\W|$)")

_MONEY_RE = re.compile(
    r"\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"(?:\s*(billion|million|trillion|thousand))?\b",
    re.I,
)

_YEAR = r"(?:1[1-9]\d{2}|20\d{2})"
_YEAR_RANGE_RE = re.compile(rf"\b({_YEAR})\s*[\-–—]\s*({_YEAR})\b")
_DECADE_RE = re.compile(r"\b((?:1[1-9]|20)\d0)['’]?s\b")
_YEAR_RE = re.compile(rf"(?<![\d.$/])({_YEAR})(?!\.?\d)")


def _under_100(n: int) -> str:
    if n < 10:
        return _ONES[n]
    if n < 20:
        return _TEENS[n - 10]
    tens, ones = divmod(n, 10)
    return _TENS[tens] if ones == 0 else f"{_TENS[tens]} {_ONES[ones]}"


def _year_words(n: int) -> str:
    """1978 → 'nineteen seventy eight'; 2023 → 'twenty twenty three'."""
    if n == 2000:
        return "two thousand"
    if 2001 <= n <= 2009:
        return f"two thousand {_under_100(n - 2000)}"
    if 2010 <= n <= 2099:
        return f"twenty {_under_100(n - 2000)}"
    century, rest = divmod(n, 100)
    head = _under_100(century)
    if rest == 0:
        return f"{head} hundred"
    if rest < 10:
        return f"{head} oh {_under_100(rest)}"
    return f"{head} {_under_100(rest)}"


def _decade_words(n: int) -> str:
    """1970s → 'nineteen seventies'."""
    if n == 2000:
        return "two thousands"
    century, rest = divmod(n, 100)
    if rest == 0:
        return f"{_under_100(century)} hundreds"
    tens = _under_100(rest)
    if tens.endswith("y"):
        tens = tens[:-1] + "ies"
    elif tens == "ten":
        tens = "tens"
    else:
        tens += "s"
    if century == 20:
        return f"twenty {tens}"
    return f"{_under_100(century)} {tens}"


def _expand_state(m: re.Match) -> str:
    # Drop the abbreviation's own period so "Ky.—" becomes "Kentucky—" not
    # "Kentucky.—", which Kokoro would pause on.
    return m.group(1) + _STATES[m.group(2).upper()]


def _expand_state_paren(m: re.Match) -> str:
    return "(" + _STATES[m.group(1).upper()] + ")"


def _collapse_acronym(m: re.Match) -> str:
    return re.sub(r"\.", "", m.group(0))


def _money(m: re.Match) -> str:
    """'$1.3 billion' → '1.3 billion dollars'; '$1' → '1 dollar'."""
    number, scale = m.group(1), m.group(2)
    unit = "dollar" if not scale and re.fullmatch(r"1(?:\.0+)?", number) else "dollars"
    if scale:
        return f"{number} {scale.lower()} {unit}"
    return f"{number} {unit}"


def speakable(text: str) -> str:
    """Return a Kokoro-friendly rendering of `text`."""
    if not text:
        return text
    text = _STATE_RE.sub(_expand_state, text)
    text = _STATE_PAREN_RE.sub(_expand_state_paren, text)
    for pat, repl in _GEO_DOTTED:
        text = pat.sub(repl, text)
    text = _DOTTED_ACRONYM_RE.sub(_collapse_acronym, text)
    text = _MONEY_RE.sub(_money, text)
    text = _YEAR_RANGE_RE.sub(
        lambda m: f"{_year_words(int(m.group(1)))} to {_year_words(int(m.group(2)))}",
        text,
    )
    text = _DECADE_RE.sub(lambda m: _decade_words(int(m.group(1))), text)
    text = _YEAR_RE.sub(lambda m: _year_words(int(m.group(1))), text)
    return text
