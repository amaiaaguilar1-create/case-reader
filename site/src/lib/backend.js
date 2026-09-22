/**
 * PLACEHOLDER -- the backend agent owns this file.
 *
 * It exists so the worker pool can be built and measured before their choice
 * of inference backend lands. The exports and their meanings are the contract
 * the two halves meet on; replace the bodies, not the signatures.
 */

/** Where inference runs. */
export function pickBackend() {
  return "wasm";
}

/**
 * How many workers this backend should get.
 *
 * A GPU is one shared resource, so WebGPU gets one queue however many cores
 * the machine has. On WASM, ONNX already runs several threads inside each
 * worker, so workers past the third mostly compete with each other, and each
 * one costs another copy of the model (~86MB) in memory.
 */
export function workerBudget(backend) {
  if (backend === "webgpu") return 1;
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  if (cores <= 4) return 1;                  // phones: one copy of the model
  return cores >= 10 ? 3 : 2;
}
