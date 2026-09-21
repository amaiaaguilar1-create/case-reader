import { buildDocument } from "./lib/chunker.js";
import { parseFile, parseText, SAMPLE } from "./lib/parse.js";
import {
  deleteDoc, getDoc, listDocs, metaGet, metaSet, saveDoc, savePosition,
} from "./lib/db.js";
import {
  DEFAULT_VOICE, VOICES, loadVoice, packFrom, synthesize, voiceReady,
} from "./lib/tts.js";
import { remember, unlocked, verify } from "./lib/gate.js";

const $ = id => document.getElementById(id);
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

const state = {
  doc: null,
  sent: 0,
  playing: false,
  speed: 1,
  voice: DEFAULT_VOICE,
  audio: null,
  timings: [],
  pack: [],
  tIdx: 0,
  chunkCache: new Map(),
  step: 0,
  // Every play request takes the next number. Anything that resumes after an
  // await checks it still holds the current one, so an older request that was
  // waiting on synthesis cannot start speaking over the new one.
  gen: 0,
  clips: new Set(),
  durations: new Map(),
  raf: 0,
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

function isReadable(i) {
  const s = state.doc?.sentences[i];
  return s && s.kind !== "header";
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
    await loadVoice(onProgress || (() => {}));
    await metaSet("voiceSaved", true);
  } finally {
    $("banner").hidden = true;
  }
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
            $("page").hidden = true;
            $("hero").hidden = false;
            $("player").classList.remove("on");
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
  $("page").hidden = false;
  $("player").classList.add("on");
  $("docTitle").textContent = doc.title;
  $("topTitle").textContent = doc.title;
  const prose = $("prose");
  prose.innerHTML = "";
  for (const s of doc.sentences) {
    const span = document.createElement("span");
    span.className = "sent" + (s.kind === "header" ? " furn" : "");
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
}

function locatePacked(idx) {
  const parts = state.pack.length
    ? state.pack : [{ id: state.sent, words: state.timings.length }];
  let off = 0;
  for (const p of parts) {
    if (idx < off + p.words) return [p.id, idx - off];
    off += p.words;
  }
  const last = parts.at(-1);
  return [last.id, Math.max(0, last.words - 1)];
}

let lastWord = null;
function setWord(wi) {
  lastWord?.classList.remove("now");
  lastWord = document.querySelector(`.w[data-s="${state.sent}"][data-w="${wi}"]`);
  lastWord?.classList.add("now");
}

let lastSent = null;
function markSentence() {
  lastWord?.classList.remove("now");
  lastWord = null;
  lastSent?.classList.remove("now");
  lastSent = $("s" + state.sent);
  if (lastSent) {
    lastSent.classList.add("now");
    const box = lastSent.getBoundingClientRect();
    const view = $("reader").getBoundingClientRect();
    if (box.top < view.top + 48 || box.bottom > view.bottom - 180) {
      lastSent.scrollIntoView({ block: "center" });
    }
  }
  updateTime();
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
}

// Synthesis runs at roughly real time, so a pack takes about as long to make
// as it takes to hear. That sets the shape of this: the first pack is small so
// speech starts soon, and the rest are only a little larger, because a pack
// much longer than the one playing cannot be ready before it ends. Growing
// them to the chunker's full 480 characters buys nicer phrasing and pays for
// it with a silence at the first boundary.
const FIRST_CHARS = 150;
const PACK_CHARS = 170;

function packLimit(step) {
  return step === 0 ? FIRST_CHARS : PACK_CHARS;
}

async function fetchChunk(sentId, limit) {
  const key = `${sentId}|${state.voice}|${limit || "full"}`;
  if (!state.chunkCache.has(key)) {
    state.chunkCache.set(key, (async () => {
      const pack = packFrom(state.doc.sentences, sentId, limit);
      const clip = await synthesize(pack.text, pack.words, state.voice);
      state.durations.set(pack.ids[0], clip.duration);
      for (const id of pack.ids.slice(1)) state.durations.set(id, 0);
      const el = new Audio(clip.url);
      el.preload = "auto";
      state.clips.add(el);
      return { ...clip, ...pack, el };
    })());
  }
  return state.chunkCache.get(key);
}

async function playSentence(sentId, continuing = false) {
  if (!state.doc) return;
  // Reading on from the previous pack belongs to the request that started it;
  // anything else is a new request and supersedes whatever was pending.
  const gen = continuing ? state.gen : ++state.gen;
  const docId = state.doc.id;
  const current = () => gen === state.gen && state.doc?.id === docId;

  try { await ensureVoice(); }
  catch { toast("Couldn’t get the voice ready. Check your connection and try again."); return; }
  if (!current()) return;
  const target = nextReadable(sentId, 1);
  if (target < 0) { stop(); return; }
  sentId = target;
  silence();
  cancelAnimationFrame(state.raf);
  state.sent = sentId;
  markSentence();
  if (!state.playing) setPlayIcon("load");
  // Reading on from the last pack keeps the ramp; anything the reader asked
  // for -- play, a seek, a tapped word -- starts small again so it is quick.
  const step = continuing ? state.step + 1 : 0;
  state.step = step;
  let chunk;
  try { chunk = await fetchChunk(sentId, packLimit(step)); }
  catch (e) {
    if (current()) { toast(e.message || "Playback failed."); stop(); }
    return;
  }
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
  const ahead = nextReadable(chunk.through + 1, 1);
  a.onended = () => playSentence(ahead, true);
  try { await a.play(); } catch { if (current()) stop(); return; }
  if (!current()) { a.onended = null; a.pause(); return; }
  state.playing = true;
  setPlayIcon("pause");
  savePosition(state.doc.id, state.sent).catch(() => {});
  // Keep two packs in hand, so a slow machine still reads without gaps.
  if (ahead >= 0) {
    fetchChunk(ahead, packLimit(step + 1)).then(next => {
      const after = nextReadable(next.through + 1, 1);
      if (after >= 0) fetchChunk(after, packLimit(step + 2)).catch(() => {});
    }).catch(() => {});
  }
  highlightLoop();
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
    if (s.kind === "header") continue;
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
