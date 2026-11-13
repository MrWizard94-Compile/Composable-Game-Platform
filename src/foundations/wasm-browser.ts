import { createIsolateBackend, type GuestProcess, type HostBudget, type IsolateBackend, type LogBudget } from "./wasm-isolate.ts";

type WorkerMessage = { id?: number; ok?: boolean; text?: string };

/**
 * Browser isolate. Same session, budgets, binary refusals, and log bounds as `wasm-isolate`.
 * A page cannot set a worker heap cap, so a policy that sets `isolateHeapMb` is refused before any hook runs.
 */
export function createBrowserWasmBackend(options?: {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  maxBinaryBytes?: number;
  allowCapabilities?: readonly string[];
  host?: HostBudget;
  log?: Partial<LogBudget>;
  /** Test seam. The console uses a browser worker. */
  spawn?: (heapMb: number) => GuestProcess;
}): IsolateBackend {
  return createIsolateBackend({
    id: "wasm-browser",
    supportsHeap: false,
    maxHookMs: options?.maxHookMs,
    maxMemoryBytes: options?.maxMemoryBytes,
    maxBinaryBytes: options?.maxBinaryBytes,
    allowCapabilities: options?.allowCapabilities,
    host: options?.host,
    log: options?.log,
    spawn: options?.spawn ?? defaultSpawn,
  });
}

function defaultSpawn(): GuestProcess {
  const worker = new Worker(new URL("./wasm-worker-browser.mjs", import.meta.url), { type: "module" });
  const wrappers = new Map<(message: WorkerMessage) => void, (event: MessageEvent) => void>();
  const errors = new Map<(error: Error) => void, (event: ErrorEvent) => void>();
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    addMessageListener(listener) {
      const wrapped = (event: MessageEvent) => listener(event.data as WorkerMessage);
      wrappers.set(listener, wrapped);
      worker.addEventListener("message", wrapped);
    },
    removeMessageListener(listener) {
      const wrapped = wrappers.get(listener);
      if (!wrapped) return;
      worker.removeEventListener("message", wrapped);
      wrappers.delete(listener);
    },
    addErrorListener(listener) {
      const wrapped = (event: ErrorEvent) => listener(event.error instanceof Error ? event.error : new Error(event.message));
      errors.set(listener, wrapped);
      worker.addEventListener("error", wrapped);
    },
    removeErrorListener(listener) {
      const wrapped = errors.get(listener);
      if (!wrapped) return;
      worker.removeEventListener("error", wrapped);
      errors.delete(listener);
    },
    terminate() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        worker.addEventListener("error", finish, { once: true });
        worker.terminate();
        setTimeout(finish, 0);
      });
    },
  };
}
