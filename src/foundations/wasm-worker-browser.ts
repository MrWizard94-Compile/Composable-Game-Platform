import { createGuestRuntime } from "./wasm-guest-runtime.mjs";

type GuestScope = {
  postMessage: (data: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

/** Wires the shared guest runtime to a browser worker global. */
export function attachBrowserGuest(scope: GuestScope) {
  const runtime = createGuestRuntime((id, ok, text) => {
    scope.postMessage({ id, ok, text });
  });
  scope.onmessage = (event: MessageEvent) => {
    runtime.onMessage(event.data);
  };
}

const workerScope = globalThis as GuestScope & typeof globalThis & {
  DedicatedWorkerGlobalScope?: new (...args: never[]) => object;
};
const WorkerScope = workerScope.DedicatedWorkerGlobalScope;
if (typeof WorkerScope === "function" && globalThis instanceof WorkerScope) {
  attachBrowserGuest(workerScope);
}
