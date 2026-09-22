/**
 * Which backend gets picked, for machines we cannot put on the desk.
 *
 * The measurements behind these choices are in bench/bench.js and the header
 * of backend.js. What is checked here is only the decision: that a phone on a
 * metered connection is not sent a 326MB model, that a software GPU adapter is
 * turned down, and that every path -- including a probe that throws -- ends on
 * a configuration the site is known to run.
 */
import { expect, test } from "vitest";
import { pickBackend, wasmThreads, workerBudget } from "../src/lib/backend.js";

const SAFE = { device: "wasm", dtype: "q8" };

/** A navigator with nothing on it but what the probe is allowed to see. */
function nav({ cores = 12, memory = 32, connection, adapter = "none" } = {}) {
  const n = { hardwareConcurrency: cores, deviceMemory: memory };
  if (connection) n.connection = connection;
  if (adapter === "throws") {
    n.gpu = { requestAdapter: async () => { throw new Error("no adapter"); } };
  } else if (adapter !== "none") {
    n.gpu = { requestAdapter: async () => adapter };
  }
  return n;
}

/** A GPU that works, unless an override says otherwise. */
function metal(over = {}) {
  return {
    isFallbackAdapter: false,
    info: { vendor: "apple", architecture: "metal-3" },
    limits: { maxBufferSize: 4e9 },
    requestDevice: async () => ({ destroy() {} }),
    ...over,
  };
}

test("a real GPU gets the fast model", async () => {
  const got = await pickBackend(nav({ adapter: metal() }), true);
  expect(got).toMatchObject({ device: "webgpu", dtype: "fp32" });
  expect(got.why).toMatch(/apple/);
});

test("a software adapter is turned down: it is slower than the CPU path", async () => {
  const got = await pickBackend(nav({ adapter: metal({ isFallbackAdapter: true }) }), true);
  expect(got).toMatchObject({ device: "wasm", dtype: "fp32" });
});

test("an adapter too small to hold the weights is turned down", async () => {
  const small = metal({ limits: { maxBufferSize: 64e6 } });
  expect(await pickBackend(nav({ adapter: small }), true)).toMatchObject({ device: "wasm" });
});

test("an adapter that will not open a device is turned down", async () => {
  const shy = metal({ requestDevice: async () => null });
  expect(await pickBackend(nav({ adapter: shy }), true)).toMatchObject({ device: "wasm" });
});

test("no GPU, but cores and memory to spare, runs fp32 on the CPU", async () => {
  const got = await pickBackend(nav(), true);
  expect(got).toMatchObject({ device: "wasm", dtype: "fp32" });
  expect(got.why).toMatch(/12 cores/);
});

test("a metered connection keeps the 92MB model, GPU or not", async () => {
  for (const connection of [{ saveData: true }, { effectiveType: "3g" }, { effectiveType: "2g" }]) {
    const got = await pickBackend(nav({ adapter: metal(), connection }), true);
    expect(got).toMatchObject(SAFE);
    expect(got.why).toMatch(/metered/);
  }
});

test("an unmetered connection the browser can describe is not treated as metered", async () => {
  const got = await pickBackend(nav({ connection: { effectiveType: "4g", saveData: false } }), true);
  expect(got).toMatchObject({ dtype: "fp32" });
});

test("without cross-origin isolation the CPU path is single-threaded, so stay small", async () => {
  const got = await pickBackend(nav(), false);
  expect(got).toMatchObject(SAFE);
  expect(got.why).toMatch(/single-threaded/);
});

test("cross-origin isolation is irrelevant once the work is on the GPU", async () => {
  expect(await pickBackend(nav({ adapter: metal() }), false))
    .toMatchObject({ device: "webgpu", dtype: "fp32" });
});

test("a small machine keeps the 92MB model", async () => {
  expect(await pickBackend(nav({ cores: 4, memory: 8 }), true)).toMatchObject(SAFE);
  expect(await pickBackend(nav({ cores: 12, memory: 4 }), true)).toMatchObject(SAFE);
  expect(await pickBackend(nav({ cores: 2, memory: 2, adapter: metal() }), true))
    .toMatchObject(SAFE);
});

// deviceMemory is Chromium-only: Firefox on a large desktop reports nothing,
// and reading that as a small machine would cost it the fast model.
test("a machine that will not say how much memory it has is judged on its cores", async () => {
  expect(await pickBackend(nav({ memory: 0 }), true))
    .toMatchObject({ device: "wasm", dtype: "fp32" });
  expect(await pickBackend(nav({ memory: 0, cores: 4 }), true))
    .toMatchObject({ device: "wasm", dtype: "q8" });
});

test("a probe that throws still yields a working backend", async () => {
  const got = await pickBackend(nav({ adapter: "throws" }), true);
  expect(got).toMatchObject(SAFE);
  expect(got.why).toMatch(/probe failed/);
  expect(await pickBackend(null, true)).toMatchObject(SAFE);
});

test("every answer explains itself", async () => {
  const cases = [nav(), nav({ adapter: metal() }), nav({ cores: 1, memory: 2 }), nav({ adapter: "throws" })];
  for (const n of cases) {
    const { why } = await pickBackend(n, true);
    expect(typeof why).toBe("string");
    expect(why.length).toBeGreaterThan(10);
  }
});

test("the GPU is one resource: one worker, however many cores there are", () => {
  expect(workerBudget({ device: "webgpu", dtype: "fp32" }, nav({ cores: 64 }))).toBe(1);
});

test("the big model gets two CPU workers at most: a third thrashes", () => {
  const fp32 = { device: "wasm", dtype: "fp32" };
  expect(workerBudget(fp32, nav({ cores: 12, memory: 32 }))).toBe(2);
  expect(workerBudget(fp32, nav({ cores: 8, memory: 32 }))).toBe(1);
  expect(workerBudget(fp32, nav({ cores: 4, memory: 8 }))).toBe(1);
  // Two 330MB sessions is how a small machine loses the tab mid-sentence.
  expect(workerBudget(fp32, nav({ cores: 12, memory: 4 }))).toBe(1);
});

test("the small model gets a third worker: it is the only way it reaches 2x", () => {
  const q8 = { device: "wasm", dtype: "q8" };
  expect(workerBudget(q8, nav({ cores: 12, memory: 32 }))).toBe(3);
  expect(workerBudget(q8, nav({ cores: 12, memory: 4 }))).toBe(3);
  expect(workerBudget(q8, nav({ cores: 8, memory: 4 }))).toBe(2);
  expect(workerBudget(q8, nav({ cores: 4, memory: 4 }))).toBe(1);
});

test("an unrecognisable backend still gets a worker", () => {
  expect(workerBudget(undefined, nav({ cores: 12, memory: 32 }))).toBe(3);
  expect(workerBudget({}, nav({ cores: 2 }))).toBe(1);
});

test("threads are this worker's share of the cores, capped where they stop paying", () => {
  const fp32 = { device: "wasm", dtype: "fp32" };
  expect(wasmThreads(fp32, nav({ cores: 12, memory: 32 }))).toBe(6);   // two workers of six
  expect(wasmThreads(fp32, nav({ cores: 8, memory: 32 }))).toBe(6);    // one worker, capped
  expect(wasmThreads(fp32, nav({ cores: 4, memory: 8 }))).toBe(4);
  expect(wasmThreads(fp32, nav({ cores: 1, memory: 8 }))).toBe(1);
  expect(wasmThreads(fp32, nav({ cores: 0, memory: 8 }))).toBe(1);
  // Three q8 workers on twelve cores is four threads each, as measured.
  expect(wasmThreads({ device: "wasm", dtype: "q8" }, nav({ cores: 12 }))).toBe(4);
});
