const PAUSE = { ",": 3, ";": 4, ":": 4, ".": 6, "!": 6, "?": 6, "\u2014": 4 };
const FLOOR = 2;

function weight(word) {
  let w = FLOOR;
  for (const c of word) {
    if (/[0-9A-Za-z\u00C0-\u024F]/.test(c)) w += 1;
    w += PAUSE[c] || 0;
  }
  return w;
}

export function estimateWordTimings(words, duration) {
  if (!words.length) return [];
  const weights = words.map(w => weight(w.text));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const timings = [];
  let t = 0;
  for (const wt of weights) {
    const dur = duration * (wt / total);
    timings.push([t, t + dur]);
    t += dur;
  }
  timings[timings.length - 1][1] = duration;
  return timings;
}
