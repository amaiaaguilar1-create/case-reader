/**
 * Which inference backend the device should use, measured rather than guessed.
 *
 * Reproduce with:
 *
 *     cd site && npm i -D --no-save playwright@1
 *     node bench/bench.js                 # every configuration
 *     node bench/bench.js webgpu/fp32     # just these
 *     node bench/bench.js --parallel wasm/fp32   # 1, 2, 3 at once
 *
 * Two things this script goes out of its way to get right:
 *
 * - It serves the harness with COOP/COEP, because without cross-origin
 *   isolation onnxruntime-web runs on one thread and every WASM number is
 *   wrong by about 2x.
 * - It launches Chromium headed. Headless Chromium on a Mac has no Metal
 *   adapter and falls back to a software one, which would make WebGPU look
 *   slow for a reason that has nothing to do with the user's machine. The
 *   adapter that answered is printed with the results so a number can be
 *   believed or thrown out.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const PORT = 4174;

// Packs the size the reader actually asks for (see packFrom's 170-char
// budget), in the register this app reads: court prose, names, numbers.
const TEXTS = [
  "The district court granted summary judgment for the defendant, holding that the plaintiff had failed to establish a genuine dispute of material fact.",
  "On appeal, the panel reversed. Judge Calabresi, writing for the majority, concluded that the record contained evidence from which a jury could find otherwise.",
  "Seventeen witnesses testified over the course of nine days, and the jury returned a verdict of four hundred thousand dollars in compensatory damages.",
  "We review the grant of summary judgment de novo, construing the evidence in the light most favorable to the nonmoving party, as our precedent requires.",
  "The dissent argues that the majority has quietly expanded the doctrine. Respectfully, it has not; it has applied the rule the Supreme Court laid down.",
  "Because the contract is unambiguous on its face, the parol evidence rule bars the testimony the plaintiff offered about the parties' earlier negotiations.",
];

// Every dtype transformers.js can name against a file this repo publishes.
// fp16 is left out of the WASM row because onnxruntime-web's WASM backend has
// no float16 kernels and simply refuses the session.
const ALL = [
  ["wasm", "q8"], ["wasm", "q4"], ["wasm", "uint8"], ["wasm", "fp32"],
  ["webgpu", "fp32"], ["webgpu", "fp16"], ["webgpu", "q4f16"],
  ["webgpu", "q8"], ["webgpu", "uint8"], ["webgpu", "q4"],
];

const mb = n => (n / 1e6).toFixed(0);

/** How far a clip has drifted from the q8 baseline, envelope against envelope. */
function envelopeCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb2 = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb2;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * A verdict on the clip itself, before any comparison.
 *
 * The Python side of this project has watched int8 collapse to near-silence
 * for particular voice/text pairs, so low precision is guilty until measured:
 * a clip that is mostly silence, barely above the noise floor, clipped, or
 * suspiciously short for its text is called out by name.
 *
 * The non-finite and runaway-length checks are not theoretical. webgpu/uint8
 * returned 91 seconds of NaN for a 149-character sentence and, because every
 * comparison against NaN is false, sailed through an earlier version of this
 * function with a healthy-looking 4.6x. A speed number means nothing until
 * the thing it produced is known to be audio.
 */
function verdict(result, baseline) {
  const bad = [];
  for (const [i, p] of result.packs.entries()) {
    const base = baseline?.packs[i];
    // JSON turns NaN into null on the way back from the page.
    if (p.rms === null || p.peak === null || !Number.isFinite(p.rms)) {
      bad.push(`pack ${i + 1}: non-finite samples`);
      continue;
    }
    // Kokoro reads at roughly 15 characters a second; triple that is not speech.
    if (p.seconds > p.chars / 5) bad.push(`pack ${i + 1}: ${p.seconds.toFixed(0)}s for ${p.chars} chars`);
    if (p.rms < 0.01) bad.push(`pack ${i + 1}: near-silent (rms ${p.rms.toFixed(4)})`);
    if (p.silentFraction > 0.6) bad.push(`pack ${i + 1}: ${(p.silentFraction * 100) | 0}% silence`);
    if (p.clipped > 8) bad.push(`pack ${i + 1}: ${p.clipped} clipped samples`);
    if (base && p.seconds < base.seconds * 0.8) bad.push(`pack ${i + 1}: ${(p.seconds / base.seconds).toFixed(2)}x baseline duration`);
    if (base && p.zcr > base.zcr * 1.5) bad.push(`pack ${i + 1}: ${(p.zcr / base.zcr).toFixed(2)}x baseline brightness`);
  }
  const corr = baseline
    ? result.envelopes.map((e, i) => envelopeCorrelation(e, baseline.envelopes[i]))
    : [];
  const worst = corr.length ? Math.min(...corr) : 1;
  return { flags: bad, minEnvelopeCorrelation: worst };
}

const args = process.argv.slice(2);
const parallel = args.includes("--parallel");
const threadSweep = args.includes("--threads");
const viaWorker = args.includes("--worker");
const wanted = args.filter(a => !a.startsWith("--"));
const configs = wanted.length ? wanted.map(w => w.split("/")) : ALL;

const server = await createServer({
  root: SITE,
  configFile: false,
  server: {
    port: PORT,
    // onnxruntime-web only spawns its thread pool when the page is
    // cross-origin isolated; the deployed site gets these from a service
    // worker, and the dev server has to supply them itself.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: { include: ["kokoro-js"] },
});
await server.listen();

const profile = mkdtempSync(join(tmpdir(), "kokoro-bench-"));
const browser = await chromium.launchPersistentContext(profile, { headless: false });

const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/bench/harness.html`);
await page.waitForFunction(() => !!window.__bench, null, { timeout: 60_000 });
const caps = await page.evaluate(() => window.__bench.caps);
const adapter = await page.evaluate(() => window.__bench.adapterInfo());
console.log("capabilities:", JSON.stringify(caps, null, 2));
console.log("adapter:", JSON.stringify(adapter, null, 2));
await page.close();

/** A page already loaded and warmed, ready to be timed. */
async function warmPage(device, dtype, threads) {
  const p = await browser.newPage();
  await p.goto(`http://localhost:${PORT}/bench/harness.html`);
  await p.waitForFunction(() => !!window.__bench, null, { timeout: 60_000 });
  await p.evaluate(a => window.__bench.run(a), { device, dtype, threads, texts: [TEXTS[0]] });
  return p;
}

/**
 * Does a second synthesis running at the same time buy anything?
 *
 * This is what workerBudget has to answer. Each page is its own realm with its
 * own onnxruntime thread pool, which is what a second worker would be, so the
 * aggregate ratio across N pages says whether the cores are already saturated
 * by one of them.
 */
/** What the app itself gets: pickBackend's choice, driven through the worker. */
if (viaWorker) {
  const p = await browser.newPage();
  p.on("console", m => { if (m.type() === "error") console.log(`  [page] ${m.text()}`); });
  await p.goto(`http://localhost:${PORT}/bench/harness.html`);
  await p.waitForFunction(() => !!window.__bench, null, { timeout: 60_000 });
  const r = await p.evaluate(a => window.__bench.runWorker(a), { texts: TEXTS });
  console.log(`\nthrough src/lib/tts.worker.js`);
  console.log(`  chose:   ${r.backend.device}/${r.backend.dtype} -- ${r.backend.why}`);
  for (const n of r.notes) console.log(`  note:    ${n.name}: ${n.why}`);
  console.log(`  threads: cross-origin isolated = ${r.threads}`);
  console.log(`  load:    ${(r.loadMs / 1000).toFixed(1)}s`);
  console.log(`  ratio:   ${r.realTimeRatio.toFixed(2)}x real time`);
  console.log(`  quality: ${JSON.stringify(verdict(r, null).flags)}`);
  await browser.close();
  await server.close();
  process.exit(0);
}

/**
 * Is the WASM thread pool the limit, or is the model?
 *
 * onnxruntime-web caps itself at four threads however many cores there are, so
 * the answer decides both whether to raise numThreads and whether a second
 * worker has cores left to run on.
 */
if (threadSweep) {
  const [device, dtype] = configs[0];
  console.log(`\nthread sweep, ${device}/${dtype} (${caps.hardwareConcurrency} cores)`);
  for (const threads of [1, 2, 4, 6, 8, 12]) {
    const p = await browser.newPage();
    await p.goto(`http://localhost:${PORT}/bench/harness.html`);
    await p.waitForFunction(() => !!window.__bench, null, { timeout: 60_000 });
    const r = await p.evaluate(
      a => window.__bench.run(a), { device, dtype, texts: TEXTS.slice(0, 4), threads },
    );
    console.log(`  ${String(threads).padStart(2)} threads: ${r.realTimeRatio.toFixed(2)}x real time`);
    await p.close();
  }
  await browser.close();
  await server.close();
  process.exit(0);
}

if (parallel) {
  const [device, dtype] = configs[0];
  const cores = caps.hardwareConcurrency;
  console.log(`\nparallel scaling, ${device}/${dtype} (${cores} cores)`);
  // Split the cores between the workers rather than letting each one ask for
  // the whole machine: two sessions of six threads is the arrangement a pool
  // of two would actually get, and the only fair thing to compare against one
  // session of twelve.
  for (const n of [1, 2, 3]) {
    const threads = device === "wasm" ? Math.max(1, Math.floor(cores / n)) : undefined;
    const pages = await Promise.all(
      Array.from({ length: n }, () => warmPage(device, dtype, threads)),
    );
    const started = Date.now();
    const runs = await Promise.all(pages.map(
      p => p.evaluate(a => window.__bench.run(a), { device, dtype, threads, texts: TEXTS.slice(1, 4) }),
    ));
    const wallS = (Date.now() - started) / 1000;
    const audioS = runs.reduce((a, r) => a + r.packs.reduce((x, p) => x + p.seconds, 0), 0);
    console.log(`  ${n} at once${threads ? ` x ${threads} threads` : ""}: `
      + `${(audioS / wallS).toFixed(2)}x real time aggregate`
      + ` (${(audioS / wallS / n).toFixed(2)}x each)`);
    await Promise.all(pages.map(p => p.close()));
  }
  await browser.close();
  await server.close();
  process.exit(0);
}

const results = [];
const coldFor = new Set();   // a dtype already downloaded loads from cache
for (const [device, dtype] of configs) {
  const cold = !coldFor.has(dtype);
  coldFor.add(dtype);
  const p = await browser.newPage();
  p.on("console", m => { if (m.type() === "error") console.log(`  [page] ${m.text()}`); });
  await p.goto(`http://localhost:${PORT}/bench/harness.html`);
  await p.waitForFunction(() => !!window.__bench, null, { timeout: 60_000 });
  process.stdout.write(`\n${device}/${dtype}${cold ? " (cold)" : " (cached)"} ... `);
  try {
    const r = await p.evaluate(
      args => window.__bench.run(args),
      { device, dtype, texts: TEXTS, keepWave: true },
    );
    r.cold = cold;
    results.push(r);
    console.log(`${r.realTimeRatio.toFixed(2)}x real time, load ${(r.loadMs / 1000).toFixed(1)}s, ${mb(r.downloadBytes)}MB`);
  } catch (err) {
    console.log(`FAILED: ${String(err.message).split("\n")[0]}`);
    results.push({ device, dtype, cold, failed: String(err.message).split("\n")[0] });
  }
  await p.close();
}

await browser.close();
await server.close();

const baseline = results.find(r => r.device === "wasm" && r.dtype === "q8" && !r.failed);
console.log(`\n${"config".padEnd(14)}${"ratio".padEnd(9)}${"download".padEnd(11)}${"load".padEnd(9)}${"1st pack".padEnd(10)}quality`);
for (const r of results) {
  const name = `${r.device}/${r.dtype}`;
  if (r.failed) { console.log(`${name.padEnd(14)}${r.failed}`); continue; }
  const q = verdict(r, baseline);
  const note = q.flags.length ? q.flags.join("; ")
    : `ok (envelope r=${q.minEnvelopeCorrelation.toFixed(3)})`;
  console.log(
    name.padEnd(14)
    + `${r.realTimeRatio.toFixed(2)}x`.padEnd(9)
    + `${mb(r.downloadBytes)}MB`.padEnd(11)
    + `${(r.loadMs / 1000).toFixed(1)}s${r.cold ? "" : "*"}`.padEnd(9)
    + `${(r.firstPackMs / 1000).toFixed(1)}s`.padEnd(10)
    + note,
  );
}
console.log("* loaded from HTTP cache, not a cold download");

const out = join(profile, "results.json");
writeFileSync(out, JSON.stringify({ caps, adapter, results }, null, 2));
console.log(`\nfull results (waveforms included): ${out}`);
