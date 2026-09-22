import { buildDocument } from "./lib/chunker.js";
import { parseFile, parseText, SAMPLE } from "./lib/parse.js";
import {
  deleteDoc, getDoc, listDocs, metaGet, metaSet, saveDoc, savePosition,
} from "./lib/db.js";
import {
  DEFAULT_VOICE, NOW, SOON, VOICES, dropGuesses, loadVoice, packFrom, raise,
  synthesize, voiceReady,
} from "./lib/tts.js";
import { remember, unlocked, verify } from "./lib/gate.js";
import {
  clearWord, hasPages, mount as mountPages, mounted as pagesMounted,
  paintSentence, paintWord, unmount as unmountPages,
} from "./lib/pageview.js";

const $ = id => document.getElementById(id);
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

// Which view this device last used. It belongs to the device, not the
// document: the original page is the point on a laptop, and prose is the
// kinder read on a phone. Private browsing can refuse storage, so both
// sides shrug and fall back to the page.
const PREF = {
  get view() {
    try { return localStorage.getItem("caseReader.view") === "prose" ? "prose" : "original"; }
    catch { return "original"; }
  },
  set view(v) {
    try { localStorage.setItem("caseReader.view", v); } catch { /* not storable */ }
  },
};

const state = {
  doc: null,
  view: PREF.view,
  sent: 0,
  playing: false,
  speed: 1,
  voice: DEFAULT_VOICE,
  audio: null,
  timings: [],
  pack: [],
  tIdx: 0,
  chunkCache: new Map(),
  // Speech that is made but not yet heard, keyed by the place it starts and
  // pointing at the place it ends, so the queue can be followed from wherever
  // the reader is. It is what says how much room the next pack has.
  ahead: new Map(),
  nextAt: "",
  // Measured from the clips that come back, so the sums below follow the
  // voice and the machine rather than a guess made on one laptop.
  charsPerSec: 14,
  ratio: 0.95,
  // Every play request takes the next number. Anything that resumes after an
  // await checks it still holds the current one, so an older request that was
  // waiting on synthesis cannot start speaking over the new one.
  gen: 0,
  clips: new Set(),
  durations: new Map(),
  raf: 0,
  // When the queue was last topped up. The check is cheap but it runs off the
  // highlight loop, which is every frame.
  lastAhead: 0,
};

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $("toast").classList.remove("on"), 3200);
}

function showStep(name) {
  $("onboard").querySelectorAll(".onboard-card").forEach(el => {
    el.hidden = el.dataset.step !== name;
  });
}

function showOnboard() {
  $("onboard").hidden = false;
  $("app").hidden = true;
}

function showApp() {
  $("onboard").hidden = true;
  $("app").hidden = false;
}

function setPlayIcon(kind) {
  $("playIcon").innerHTML = kind === "pause" ? PAUSE : kind === "load"
    ? '<span class="spin"></span>' : PLAY;
  $("play").setAttribute("aria-label", kind === "pause" ? "Pause" : "Play");
}

// Only the narrative is spoken. Running heads and feet, footnotes, endnotes,
// exhibit tables and the publisher's licensing block are all on the page to be
// looked at, not listened to; layout.js is what tells them apart.
function isReadable(i) {
  const s = state.doc?.sentences[i];
  return s && s.kind === "body";
}

function nextReadable(from, dir) {
  for (let i = from; i >= 0 && i < state.doc.sentences.length; i += dir) {
    if (isReadable(i)) return i;
  }
  return -1;
}

function readableIds() {
  return state.doc.sentences.map(s => s.id).filter(isReadable);
}

async function ensureVoice(onProgress) {
  if (voiceReady()) return;
  $("banner").hidden = false;
  try {
    await loadVoice(onProgress || (() => {}), state.voice);
    await metaSet("voiceSaved", true);
  } finally {
    $("banner").hidden = true;
  }
}

/**
 * Say how the first pack is coming along.
 *
 * The wait is the length of the pack being made, and we know its size and how
 * fast this machine speaks, so the estimate is honest. A spinner that sits
 * there for four seconds reads as a freeze; a number that moves does not.
 * Returns the function that takes the message away again.
 */
let bannerText = "";
function awaiting(limit) {
  const el = $("banner");
  bannerText ||= el.textContent;
  const expect = Math.max(400, 1000 * limit / state.charsPerSec * state.ratio);
  const from = performance.now();
  const timer = setInterval(() => {
    const done = (performance.now() - from) / expect;
    if (done < 0.15) return;  // a flash of text is worse than no text
    el.textContent = `Getting the first words ready… ${Math.min(99, Math.round(done * 100))}%`;
    el.hidden = false;
  }, 150);
  return () => {
    clearInterval(timer);
    el.hidden = true;
    el.textContent = bannerText;
  };
}

async function importDoc(built) {
  const saved = await saveDoc(built);
  await metaSet("onboarded", true);
  await refreshLibrary();
  await openDoc(saved.id);
  showApp();
}

async function refreshLibrary() {
  const docs = await listDocs();
  const lib = $("lib");
  lib.innerHTML = docs.length ? "" : '<p class="fine">Nothing here yet.</p>';
  for (const d of docs) {
    const b = document.createElement("button");
    b.className = "lib-item" + (state.doc?.id === d.id ? " on" : "");
    b.type = "button";
    const n = d.sentences?.length || 0;
    b.innerHTML = `<div class="t"></div><div class="m">${n} passage${n === 1 ? "" : "s"}</div>
      <span class="del" title="Remove">×</span>`;
    b.querySelector(".t").textContent = d.title;
    b.onclick = e => {
      if (e.target.closest(".del")) {
        e.stopPropagation();
        deleteDoc(d.id).then(async () => {
          if (state.doc?.id === d.id) {
            state.doc = null;
            clearView();
          }
          await refreshLibrary();
        });
        return;
      }
      openDoc(d.id);
      $("rail").classList.remove("open");
    };
    lib.appendChild(b);
  }
}

function renderDoc(doc) {
  $("hero").hidden = true;
  $("player").classList.add("on");
  $("docTitle").textContent = doc.title;
  $("topTitle").textContent = doc.title;
  renderProse(doc);
  unmountPages($("sheets"));
  if (hasPages(doc)) {
    mountPages($("sheets"), doc, playSentence).catch(() => {
      // The page render needs the original file back. If it will not open,
      // prose is still a complete read of the same document.
      unmountPages($("sheets"));
      applyView();
    });
  }
  applyView();
}

function renderProse(doc) {
  const prose = $("prose");
  prose.innerHTML = "";
  for (const s of doc.sentences) {
    const span = document.createElement("span");
    span.className = "sent" + (s.kind === "body" ? "" : " furn");
    span.id = "s" + s.id;
    s.words.forEach((w, i) => {
      const word = document.createElement("span");
      word.className = "w";
      word.dataset.s = s.id;
      word.dataset.w = i;
      word.textContent = w.text;
      word.onclick = () => playSentence(s.id);
      span.appendChild(word);
      span.appendChild(document.createTextNode(" "));
    });
    prose.appendChild(span);
    prose.appendChild(document.createTextNode(" "));
  }
}

/** Is the highlight being drawn on the page render rather than in prose? */
function onPages() {
  return state.view === "original" && pagesMounted();
}

function applyView() {
  const paged = pagesMounted();
  const original = paged && state.view === "original";
  $("page").hidden = !state.doc || original;
  $("sheets").hidden = !original;
  $("view").hidden = !paged;
  // The chip names the view it switches to, not the one showing.
  $("viewTxt").textContent = original ? "Text" : "Original";
  markSentence();
}

/** Put the reader back on the empty state, with nothing left rendering. */
function clearView() {
  unmountPages($("sheets"));
  $("sheets").hidden = true;
  $("page").hidden = true;
  $("hero").hidden = false;
  $("view").hidden = true;
  $("player").classList.remove("on");
}

async function openDoc(id) {
  const doc = await getDoc(id);
  if (!doc) return;
  stop();
  state.doc = doc;
  state.sent = doc.position || 0;
  state.chunkCache.clear();
  state.clips.clear();
  state.durations.clear();
  renderDoc(doc);
  markSentence();
  await refreshLibrary();
  prefetchOpening(doc.id);
}

function locatePacked(idx) {
  const parts = state.pack.length
    ? state.pack : [{ id: state.sent, words: state.timings.length }];
  let off = 0;
  // `from` is where the pack picked the sentence up: a pack may start partway
  // through a long one, and the word being lit is counted from its beginning.
  for (const p of parts) {
    if (idx < off + p.words) return [p.id, (p.from || 0) + idx - off];
    off += p.words;
  }
  const last = parts.at(-1);
  return [last.id, Math.max(0, (last.from || 0) + last.words - 1)];
}

let lastWord = null, lastWordKey = null;
function setWord(wi) {
  // The highlight loop asks on every frame. Only touch the DOM when the
  // spoken word has actually moved on.
  const key = state.sent + ":" + wi;
  if (key === lastWordKey) return;
  lastWordKey = key;
  if (onPages()) {
    paintWord(state.doc.sentences[state.sent], wi);
    return;
  }
  lastWord?.classList.remove("now");
  lastWord = document.querySelector(`.w[data-s="${state.sent}"][data-w="${wi}"]`);
  lastWord?.classList.add("now");
}

let lastSent = null;
function markSentence() {
  if (!state.doc) return;
  lastWordKey = null;
  if (onPages()) {
    clearWord();
    scrollIfNeeded(paintSentence(state.doc.sentences[state.sent]));
  } else {
    lastWord?.classList.remove("now");
    lastWord = null;
    lastSent?.classList.remove("now");
    lastSent = $("s" + state.sent);
    if (lastSent) {
      lastSent.classList.add("now");
      scrollIfNeeded(lastSent);
    }
  }
  updateTime();
}

/** Nudge the sentence back into view, but only once it has drifted towards
 *  an edge -- the player bar covers the bottom of the reader. */
function scrollIfNeeded(el) {
  if (!el) return;
  const box = el.getBoundingClientRect();
  const view = $("reader").getBoundingClientRect();
  if (box.top < view.top + 48 || box.bottom > view.bottom - 180) {
    el.scrollIntoView({ block: "center" });
  }
}

function highlightLoop() {
  state.raf = requestAnimationFrame(highlightLoop);
  const a = state.audio;
  if (!a || a.paused || !state.timings.length) return;
  const t = a.currentTime;
  let i = state.tIdx;
  while (i < state.timings.length - 1 && t >= state.timings[i][1]) i++;
  while (i > 0 && t < state.timings[i][0]) i--;
  state.tIdx = i;
  const [sent, local] = locatePacked(i);
  if (sent !== state.sent) { state.sent = sent; markSentence(); }
  setWord(local);
  updateTime();
  // Top the queue up as it drains, rather than only when a pack ends.
  // Pressing 2x halves what the speech in hand is worth in listening time, and
  // the end of the current pack is the latest possible moment to notice.
  const now = performance.now();
  if (now - state.lastAhead > 250) {
    state.lastAhead = now;
    runAhead(state.doc?.id);
  }
}

// One pack takes about as long to make as it takes to hear -- 0.93x real time
// on a 12-core Mac, and near enough the same whether the pack is five seconds
// of speech or thirteen. Two things follow, and neither is changed by making
// several packs at once. A pack can only be a little longer than the speech
// already in hand, or it is still being made when the reader reaches the end
// of the queue and hears silence. And the wait before the first word is almost
// exactly the length of the first pack, which is why the opening is a few
// seconds of speech and no more, even when that means stopping partway through
// a long sentence.
const FIRST_CHARS = 44;
const PACK_CHARS = 170;
const OPENING_BANK = 26;

// How far ahead to keep speech made, in seconds of listening -- so at 2x it is
// twice as much speech. What the pool buys is the room to hold a bank this
// deep; the bank is what absorbs a pack that comes back slower than the one
// before it. Every pack in it is a WAV in memory, about half a megabyte for
// ten seconds of speech, so the cap on how many are out at once is what keeps
// a long document from banking megabytes nobody will hear.
const HORIZON = 30;
const MAX_AHEAD = 8;

const ease = (was, now) => was + 0.4 * (now - was);
// How fast this voice speaks, guessed low: a pack that comes out shorter than
// its budget costs a little growth, one that comes out longer costs silence.
// So drop to a slower reading at once, and creep back up.
const guessLow = (was, now) => (now < was ? now : was + 0.05 * (now - was));

const at = (sentId, word) => `${sentId}+${word}`;

/**
 * Seconds of wall clock covered by speech that is made and not yet heard.
 *
 * Only the packs that follow on from each other count: after a seek the queue
 * may still hold clips for somewhere else, and they are no help here.
 */
function banked() {
  const a = state.audio;
  let s = a && !a.paused && a.duration ? Math.max(0, a.duration - a.currentTime) : 0;
  const seen = new Set();
  for (let pos = state.nextAt; state.ahead.has(pos) && !seen.has(pos);) {
    seen.add(pos);
    const link = state.ahead.get(pos);
    s += link.duration;
    pos = link.next;
  }
  return s / state.speed;
}

/**
 * How long the next pack may be, in characters, given `seconds` of speech in
 * hand.
 *
 * Making speech costs `ratio` seconds per second of speech, so that much can
 * be made in the time it takes to hear what is queued. The margin keeps a
 * little under the ceiling; with nothing in hand the pack gets the floor.
 */
function packLimit(seconds) {
  const room = seconds * 0.96 / state.ratio;
  return Math.max(FIRST_CHARS,
    Math.min(PACK_CHARS, Math.round(room * state.charsPerSec)));
}

/**
 * The size to ask for at `pos`. Speech already made for that exact spot is
 * speech we keep: asking for a different size would throw away a pack that is
 * ready to play.
 */
function limitFor(pos) {
  return state.ahead.get(pos)?.limit ?? packLimit(banked());
}

async function fetchChunk(sentId, fromWord, limit, opts = {}) {
  const key = `${sentId}+${fromWord}|${state.voice}|${limit}`;
  let slot = state.chunkCache.get(key);
  if (!slot) {
    const pack = packFrom(state.doc.sentences, sentId, limit, fromWord);
    // Claim the place before the work starts. Whoever asks for it next -- the
    // reader arriving here, the run-ahead getting there -- then asks for this
    // same size and waits for this pack, instead of setting a second one going
    // that nobody will listen to.
    state.ahead.set(at(sentId, fromWord), { duration: 0, next: "", limit });
    slot = { text: pack.text, chunk: makeChunk(pack, sentId, fromWord, key, opts) };
    state.chunkCache.set(key, slot);
  } else if ((opts.priority ?? NOW) === NOW) {
    // A guess the reader is now waiting for: it goes to the front of the queue.
    raise(slot.text, state.voice);
  }
  return slot.chunk;
}

async function makeChunk(pack, sentId, fromWord, key, opts) {
  const clip = await synthesize(pack.text, pack.words, state.voice, opts);
  // A part-sentence adds to what its earlier part already counted.
  const head = pack.ids[0];
  state.durations.set(head,
    (fromWord ? state.durations.get(head) || 0 : 0) + clip.duration);
  for (const id of pack.ids.slice(1)) state.durations.set(id, 0);
  if (clip.duration > 0) {
    state.charsPerSec = guessLow(state.charsPerSec, pack.text.length / clip.duration);
    if (clip.ms) state.ratio = ease(state.ratio, clip.ms / 1000 / clip.duration);
  }
  const el = new Audio(clip.url);
  el.preload = "auto";
  state.clips.add(el);
  const from = at(sentId, fromWord);
  const to = pack.thruWord
    ? at(pack.through, pack.thruWord)
    : at(nextReadable(pack.through + 1, 1), 0);
  // Speech in hand, until the moment it starts playing.
  const link = state.ahead.get(from);
  if (link) {
    link.duration = clip.duration;
    link.next = to;
  }
  return { ...clip, ...pack, key, from, to, el };
}

/**
 * Start making the opening of a document nobody has pressed play on yet.
 *
 * Synthesis is the whole of the wait, and the worker sits idle while a
 * document is merely open, so the first packs can be ready before they are
 * asked for. The work goes in below anything being listened to and is dropped
 * the moment the reader opens something else.
 */
async function prefetchOpening(docId) {
  const tag = String(docId);
  dropGuesses(tag);
  // The voice may still be loading when a document is opened -- it is loaded
  // on the way in either way, so wait for it rather than give up the guess.
  if (!voiceReady()) {
    try { await loadVoice(); } catch { return; }
    if (state.doc?.id !== docId || state.playing) return;
  }
  let sent = nextReadable(state.sent, 1);
  if (sent < 0) return;
  // The opening mouthful on its own first. It is the one the reader waits for
  // if they press play now, and the pool must not have it queued behind the
  // guesses that follow it.
  let chunk;
  try { chunk = await fetchChunk(sent, 0, FIRST_CHARS, { priority: SOON, tag }); }
  catch { return; }
  if (state.doc?.id !== docId || state.playing) return;
  let made = chunk.duration, word = chunk.thruWord;
  sent = word ? chunk.through : nextReadable(chunk.through + 1, 1);
  // The rest go out together rather than one behind the next, so that a pool
  // has something for every worker while the document sits open and silent.
  for (let i = 1; i < 6 && sent >= 0 && made < OPENING_BANK; i++) {
    const limit = packLimit(made);
    const pack = packFrom(state.doc.sentences, sent, limit, word);
    if (!pack.ids.length) return;
    fetchChunk(sent, word, limit, { priority: SOON, tag }).catch(() => {});
    made += pack.text.length / state.charsPerSec;
    word = pack.thruWord;
    sent = word ? pack.through : nextReadable(pack.through + 1, 1);
  }
}

async function playSentence(sentId, continuing = false, fromWord = 0) {
  if (!state.doc) return;
  // Reading on from the previous pack belongs to the request that started it;
  // anything else is a new request and supersedes whatever was pending.
  const gen = continuing ? state.gen : ++state.gen;
  const docId = state.doc.id;
  const current = () => gen === state.gen && state.doc?.id === docId;

  try { await ensureVoice(); }
  catch { toast("Couldn’t get the voice ready. Check your connection and try again."); return; }
  if (!current()) return;
  const target = fromWord ? sentId : nextReadable(sentId, 1);
  if (target < 0) { stop(); return; }
  sentId = target;
  silence();
  cancelAnimationFrame(state.raf);
  state.sent = sentId;
  markSentence();
  if (!state.playing) setPlayIcon("load");
  // Whatever speech is already in hand for this place decides how long this
  // pack may be. Reading on, that is the rest of the queue; when the reader
  // has just asked for somewhere new it is usually nothing, so the pack is
  // short and the first word comes quickly.
  state.nextAt = at(sentId, fromWord);
  const limit = limitFor(state.nextAt);
  let chunk;
  const done = continuing ? null : awaiting(limit);
  try { chunk = await fetchChunk(sentId, fromWord, limit, { tag: String(docId) }); }
  catch (e) {
    done?.();
    if (current()) { toast(e.message || "Playback failed."); stop(); }
    return;
  }
  done?.();
  // Synthesis takes seconds. The reader may have pressed play on something
  // else in the meantime -- both documents start at sentence 0, so comparing
  // sentence numbers alone used to let both of them start speaking.
  if (!current()) return;
  state.timings = chunk.timings;
  state.pack = chunk.parts;
  state.tIdx = 0;
  const a = chunk.el;
  a.currentTime = 0;
  a.playbackRate = state.speed;
  if ("preservesPitch" in a) a.preservesPitch = true;
  state.audio = a;
  // Where reading goes on: the rest of this sentence, if the pack stopped
  // partway through it, or the next one.
  const onWord = chunk.thruWord;
  const onSent = onWord ? chunk.through : nextReadable(chunk.through + 1, 1);
  a.onended = () => playSentence(onSent, true, onWord);
  try { await a.play(); } catch { if (current()) stop(); return; }
  if (!current()) { a.onended = null; a.pause(); return; }
  state.playing = true;
  state.ahead.delete(state.nextAt);
  state.nextAt = chunk.to;
  setPlayIcon("pause");
  savePosition(state.doc.id, state.sent).catch(() => {});
  state.lastAhead = performance.now();
  runAhead(docId);
  highlightLoop();
}

/**
 * Ask for everything the next `HORIZON` seconds of listening needs.
 *
 * Walks forward from where playback will pick up, sizing each pack against
 * what the bank will hold by the time it is reached and asking for the ones
 * nobody has asked for yet. It has to be a walk, not a chain: the old version
 * asked for the next pack only once the last one came back, so however many
 * workers there were, at most one was ever busy. Packs are worked out from
 * `packFrom`, which is pure, so the walk can run ahead of the audio that does
 * not exist yet.
 *
 * A pack still being made counts at the length its text predicts. That is what
 * sizes the pack after it, and it is why a slow pack shrinks its successors
 * instead of being followed by one that is even later.
 */
function runAhead(docId) {
  if (!state.doc || state.doc.id !== docId) return;
  const a = state.audio;
  let bank = a && !a.paused && a.duration ? Math.max(0, a.duration - a.currentTime) : 0;
  let [sentId, word] = state.nextAt.split("+").map(Number);
  for (let i = 0; i < MAX_AHEAD && sentId >= 0 && bank / state.speed < HORIZON; i++) {
    const pos = at(sentId, word);
    const claimed = state.ahead.get(pos);
    const limit = claimed?.limit ?? packLimit(bank / state.speed);
    const pack = packFrom(state.doc.sentences, sentId, limit, word);
    if (!pack.ids.length) return;
    if (!claimed) fetchChunk(sentId, word, limit, { tag: String(docId) }).catch(() => {});
    bank += claimed?.duration || pack.text.length / state.charsPerSec;
    word = pack.thruWord;
    sentId = word ? pack.through : nextReadable(pack.through + 1, 1);
  }
}

/** Silence every clip, not just the current one: a pending request may have
 *  started one that `state.audio` no longer points at. */
function silence() {
  for (const el of state.clips) {
    el.onended = null;
    if (!el.paused) el.pause();
  }
}

function stop() {
  state.playing = false;
  state.gen++;
  cancelAnimationFrame(state.raf);
  silence();
  // Forget the clip as well as pausing it. `resume` picks up a paused clip
  // where it left off, and stopping happens when the reader opens another
  // document -- without this, pressing play there carried on reading the one
  // they left, out of a page that no longer says those words.
  state.audio = null;
  state.timings = [];
  state.pack = [];
  state.ahead.clear();
  state.nextAt = "";
  setPlayIcon("play");
}

function pause() {
  state.playing = false;
  state.audio?.pause();
  setPlayIcon("play");
}

function resume() {
  if (!state.doc) return;
  if (state.audio && state.audio.paused && state.audio.currentTime > 0 && !state.audio.ended) {
    state.audio.play();
    state.playing = true;
    setPlayIcon("pause");
    highlightLoop();
  } else playSentence(state.sent);
}

const AVG = 3.2;
function updateTime() {
  if (!state.doc) return;
  let before = 0, total = 0;
  for (const s of state.doc.sentences) {
    if (s.kind !== "body") continue;
    const d = state.durations.get(s.id) ?? AVG;
    if (s.id < state.sent) before += d;
    total += d;
  }
  before += state.audio?.currentTime || 0;
  const cur = before / state.speed, tot = total / state.speed;
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  $("time").textContent = `${fmt(cur)} / ${fmt(tot)}`;
  $("fill").style.width = (tot ? 100 * cur / tot : 0) + "%";
}

async function addFile(file) {
  try {
    const doc = await parseFile(file);
    await importDoc(doc);
    toast(`Added “${doc.title}”`);
  } catch (e) {
    toast(e.message);
  }
}

$("helloGo").onclick = () => showStep("voice");

$("voiceGo").onclick = async () => {
  const btn = $("voiceGo");
  const err = $("voiceErr");
  err.hidden = true;
  $("voiceProg").hidden = false;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await loadVoice(p => {
      $("voiceFill").style.width = `${Math.round(p * 100)}%`;
      $("voiceLabel").textContent = p >= 1
        ? "Saved on this device."
        : `Getting the voice ready… ${Math.round(p * 100)}%`;
    });
    await metaSet("voiceSaved", true);
    showStep("add");
  } catch {
    err.textContent = "That didn’t finish. Check your Wi‑Fi and try again. It only happens once.";
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "Try again";
  }
};

$("sampleGo").onclick = async () => {
  const doc = buildDocument(SAMPLE.title, SAMPLE.text);
  await importDoc(doc);
  playSentence(0);
};

$("pdfGo").onclick = () => $("onboardFile").click();
$("onboardFile").onchange = () => {
  const f = $("onboardFile").files[0];
  if (f) addFile(f);
};
$("pasteGo").onclick = () => $("dlg").showModal();
const openAdd = () => $("addDlg").showModal();
$("addBtn").onclick = openAdd;
$("heroAdd").onclick = openAdd;
$("addPdf").onclick = () => { $("addDlg").close(); $("onboardFile").click(); };
$("addPaste").onclick = () => { $("addDlg").close(); $("dlg").showModal(); };
$("addCancel").onclick = () => $("addDlg").close();
$("addDlg").onclick = e => { if (e.target === $("addDlg")) $("addDlg").close(); };
$("menuBtn").onclick = () => $("rail").classList.toggle("open");

$("dlgClose").onclick = () => $("dlg").close();
$("dlg").onclick = e => { if (e.target === $("dlg")) $("dlg").close(); };
$("pasteForm").onsubmit = async e => {
  e.preventDefault();
  try {
    const doc = parseText($("pTitle").value, $("pText").value);
    $("dlg").close();
    await importDoc(doc);
    toast(`Added “${doc.title}”`);
  } catch (err) {
    toast(err.message);
  }
};

$("play").onclick = () => state.playing ? pause() : resume();
$("prev").onclick = () => {
  if (!state.doc) return;
  const prev = nextReadable(state.sent - 1, -1);
  if (prev >= 0) playSentence(prev);
};
$("next").onclick = () => state.doc && playSentence(state.sent + 1);
$("view").onclick = () => {
  state.view = PREF.view = state.view === "original" ? "prose" : "original";
  applyView();
};
$("speed").onclick = () => {
  state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
  $("speedTxt").textContent = state.speed + "x";
  if (state.audio) state.audio.playbackRate = state.speed;
  updateTime();
};
$("scrub").onclick = e => {
  if (!state.doc) return;
  const r = $("scrub").getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const ids = readableIds();
  if (ids.length) playSentence(ids[Math.min(ids.length - 1, Math.floor(frac * ids.length))]);
};
$("voice").onchange = e => {
  state.voice = e.target.value;
  state.chunkCache.clear();
  state.ahead.clear();
  if (state.playing) playSentence(state.sent);
};
document.addEventListener("keydown", e => {
  if (e.target.matches("input,textarea,select") || $("dlg").open) return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  if (e.key === "ArrowLeft") $("prev").click();
  if (e.key === "ArrowRight") $("next").click();
});

$("voice").innerHTML = VOICES.map(v => `<option value="${v.id}">${v.label}</option>`).join("");
$("voice").value = state.voice;
setPlayIcon("play");

async function boot() {
  const onboarded = await metaGet("onboarded");
  const voiceSaved = await metaGet("voiceSaved");
  if (!onboarded) {
    showOnboard();
    showStep(voiceSaved ? "add" : "hello");
    return;
  }
  showApp();
  await refreshLibrary();
  if (!voiceSaved) {
    try { await ensureVoice(); }
    catch { /* they can retry when they press play */ }
  } else {
    loadVoice().catch(() => {});
  }
}

$("gateForm").onsubmit = async e => {
  e.preventDefault();
  const btn = $("gateGo"), err = $("gateErr"), field = $("gatePw");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Checking\u2026";
  let ok = false;
  try {
    ok = await verify(field.value);
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = "Open";
  if (!ok) {
    if (err.hidden) {
      err.textContent = "That password doesn\u2019t match. Check the message it came in.";
      err.hidden = false;
    }
    field.select();
    return;
  }
  remember();
  field.value = "";
  $("gate").hidden = true;
  $("onboard").hidden = false;
  boot();
};

// The head script guessed which screen to show; from here [hidden] decides.
delete document.documentElement.dataset.first;
if (unlocked()) {
  $("gate").hidden = true;
  $("onboard").hidden = false;
  boot();
} else {
  $("onboard").hidden = true;
  $("gate").hidden = false;
  $("gatePw").focus();
}
