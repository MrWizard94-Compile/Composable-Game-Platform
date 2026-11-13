// @ts-check
import { createGuestRuntime } from "./wasm-guest-runtime.mjs";

/**
 * @param {{
 *   postMessage: (data: unknown) => void,
 *   onmessage: ((event: MessageEvent) => void) | null,
 * }} scope
 */
export function attachBrowserGuest(scope) {
  const runtime = createGuestRuntime((id, ok, text) => {
    scope.postMessage({ id, ok, text });
  });
  scope.onmessage = (event) => {
    runtime.onMessage(event.data);
  };
}

const scope = /** @type {typeof globalThis & { DedicatedWorkerGlobalScope?: new (...args: never[]) => object }} */ (globalThis);
const WorkerScope = scope.DedicatedWorkerGlobalScope;
if (typeof WorkerScope === "function" && globalThis instanceof WorkerScope) {
  attachBrowserGuest(scope);
}
