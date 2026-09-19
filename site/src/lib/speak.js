/** Rewrite display text so Kokoro reads it the way a person would. */

const ONES = "zero one two three four five six seven eight nine".split(" ");
const TEENS = ("ten eleven twelve thirteen fourteen fifteen sixteen "
  + "seventeen eighteen nineteen").split(" ");
const TENS = ["", "", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety"];

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida",
  GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};
const STATE_ALTS = Object.keys(STATES).join("|");
const STATE_RE = new RegExp(
  `(,\\s*)(${STATE_ALTS})(?:\\.)?(?=(?:[\\u2014\\u2013,;:\\-]|\\s+\\d{5}\\b|\\s*$|\\)))`,
  "i",
);
const STATE_PAREN_RE = new RegExp(`\\((${STATE_ALTS})\\)`, "i");

const GEO_DOTTED = [
  [/\bU\.S\.A\./g, "United States"],
  [/\bU\.S\./g, "United States"],
  [/\bU\.K\./g, "United Kingdom"],
  [/\bD\.C\./g, "District of Columbia"],
  [/\bPh\.D\./g, "PhD"],
];
const DOTTED_ACRONYM_RE = /\b(?:[A-Z]\.){2,}[A-Z]\.?(?=\W|$)/g;

const MONEY_RE = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(billion|million|trillion|thousand))?\b/gi;

const YEAR = "(?:1[1-9]\\d{2}|20\\d{2})";
const YEAR_RANGE_RE = new RegExp(`\\b(${YEAR})\\s*[\\-–—]\\s*(${YEAR})\\b`, "g");
const DECADE_RE = /\b((?:1[1-9]|20)\d0)['’]?s\b/g;
const YEAR_RE = new RegExp(`(?<![\\d.$/])(${YEAR})(?!\\.?\\d)`, "g");

function toRoman(n) {
  const glyphs = [[100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [value, glyph] of glyphs) {
    while (n >= value) { out += glyph; n -= value; }
  }
  return out;
}

const ROMAN = Object.fromEntries(
  Array.from({ length: 39 }, (_, i) => [toRoman(i + 2), i + 2]),
);
const ROMAN_ALTS = Object.keys(ROMAN).sort((a, b) => b.length - a.length).join("|");
const NTH = {
  1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
  6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
  11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth",
  15: "fifteenth", 16: "sixteenth", 17: "seventeenth", 18: "eighteenth",
  19: "nineteenth", 20: "twentieth", 21: "twenty first", 22: "twenty second",
  23: "twenty third", 24: "twenty fourth", 25: "twenty fifth",
  30: "thirtieth", 40: "fortieth",
};

const COMMON_HEADS = [
  "war", "chapter", "part", "volume", "book", "act", "scene", "appendix",
  "exhibit", "article", "section", "title", "amendment", "phase", "stage",
  "type", "class", "category", "grade", "level", "generation", "round",
  "season", "series", "episode", "game", "bowl", "mark", "model", "version",
  "table", "figure", "annex", "schedule", "clause", "paragraph", "item",
  "unit", "region", "district", "century", "dynasty", "republic", "empire",
  "crusade", "wave", "draft", "album", "symphony", "concerto", "sonata",
  "tier", "form", "case",
];
const COMMON_HEAD_ALTS = [...COMMON_HEADS].sort((a, b) => b.length - a.length).join("|");
const COMMON_ROMAN_RE = new RegExp(`\\b(${COMMON_HEAD_ALTS})\\s+(${ROMAN_ALTS}|I)\\b`, "gi");
const NAME_ROMAN_RE = new RegExp(`\\b([A-Z][A-Za-z'\\u2019\\-]*)\\s+(${ROMAN_ALTS})\\b`, "g");

function under100(n) {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const tens = Math.floor(n / 10), ones = n % 10;
  return ones === 0 ? TENS[tens] : `${TENS[tens]} ${ONES[ones]}`;
}

function yearWords(n) {
  if (n === 2000) return "two thousand";
  if (n >= 2001 && n <= 2009) return `two thousand ${under100(n - 2000)}`;
  if (n >= 2010 && n <= 2099) return `twenty ${under100(n - 2000)}`;
  const century = Math.floor(n / 100), rest = n % 100;
  const head = under100(century);
  if (rest === 0) return `${head} hundred`;
  if (rest < 10) return `${head} oh ${under100(rest)}`;
  return `${head} ${under100(rest)}`;
}

function decadeWords(n) {
  if (n === 2000) return "two thousands";
  const century = Math.floor(n / 100), rest = n % 100;
  if (rest === 0) return `${under100(century)} hundreds`;
  let tens = under100(rest);
  if (tens.endsWith("y")) tens = `${tens.slice(0, -1)}ies`;
  else if (tens === "ten") tens = "tens";
  else tens += "s";
  if (century === 20) return `twenty ${tens}`;
  return `${under100(century)} ${tens}`;
}

function nth(n) {
  if (NTH[n]) return NTH[n];
  if (n < 100) return `${under100(n)}th`;
  return `${n}th`;
}

function money(_, number, scale) {
  const unit = (!scale && /^1(?:\.0+)?$/.test(number)) ? "dollar" : "dollars";
  return scale ? `${number} ${scale.toLowerCase()} ${unit}` : `${number} ${unit}`;
}

const DASH_RE = /\s*[\u2014\u2013]+\s*/g;
const ELLIPSIS_RE = /\.\.\.+|\u2026/g;
const PAREN_RE = /\s*\(([^)]{1,80})\)/g;

function smooth(text) {
  text = text.replace(DASH_RE, ", ");
  text = text.replace(ELLIPSIS_RE, ",");
  text = text.replace(/\u201c|\u201d/g, "");
  text = text.replace(/\u2018/g, "'").replace(/\u2019/g, "'");
  text = text.replace(PAREN_RE, ", $1,");
  text = text.replace(/\s+,/g, ",");
  text = text.replace(/,\s*,+/g, ", ");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

export function speakable(text) {
  if (!text) return text;
  text = text.replace(STATE_RE, (_, comma, code) => comma + STATES[code.toUpperCase()]);
  text = text.replace(STATE_PAREN_RE, (_, code) => `(${STATES[code.toUpperCase()]})`);
  for (const [pat, repl] of GEO_DOTTED) text = text.replace(pat, repl);
  text = text.replace(DOTTED_ACRONYM_RE, m => m.replace(/\./g, ""));
  text = text.replace(MONEY_RE, money);
  text = text.replace(YEAR_RANGE_RE, (_, a, b) => `${yearWords(+a)} to ${yearWords(+b)}`);
  text = text.replace(DECADE_RE, (_, n) => decadeWords(+n));
  text = text.replace(YEAR_RE, (_, n) => yearWords(+n));
  text = text.replace(COMMON_ROMAN_RE, (m, head, roman) => {
    const n = roman.toUpperCase() === "I" ? 1 : ROMAN[roman.toUpperCase()];
    return `${head} ${under100(n)}`;
  });
  text = text.replace(NAME_ROMAN_RE, (_, name, roman) => (
    `${name} the ${nth(ROMAN[roman])}`
  ));
  return smooth(text);
}
