import { Worker } from "node:worker_threads";
import { createIsolateBackend, inspectWasm, type GuestProcess, type HostBudget, type IsolateBackend, type LogBudget } from "./wasm-isolate.ts";

export type { HostBudget, LogBudget };
export { inspectWasm };
export type WasmBackend = IsolateBackend;

type WorkerMessage = { id?: number; ok?: boolean; text?: string };

/**
 * Isolated WebAssembly backend.
 * `open` starts one composition. Its workers and memories belong to that composition
 * and die on `release`. `release` resolves after the workers have exited.
 * The host waits on a promise. It never calls `Atomics.wait`.
 */
export function createWasmBackend(options?: {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  allowCapabilities?: readonly string[];
  host?: HostBudget;
  log?: Partial<LogBudget>;
}): WasmBackend {
  return createIsolateBackend({
    id: "wasm-isolate",
    supportsHeap: true,
    maxHookMs: options?.maxHookMs,
    maxMemoryBytes: options?.maxMemoryBytes,
    allowCapabilities: options?.allowCapabilities,
    host: options?.host,
    log: options?.log,
    spawn(heapMb) {
      const young = Math.min(4, heapMb);
      const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url), {
        resourceLimits: {
          maxOldGenerationSizeMb: heapMb,
          maxYoungGenerationSizeMb: young,
          codeRangeSizeMb: 8,
          stackSizeMb: 1,
        },
      });
      worker.unref();
      return nodeProcess(worker);
    },
  });
}

function nodeProcess(worker: Worker): GuestProcess {
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    addMessageListener(listener) {
      worker.on("message", listener as (message: WorkerMessage) => void);
    },
    removeMessageListener(listener) {
      worker.off("message", listener as (message: WorkerMessage) => void);
    },
    addErrorListener(listener) {
      worker.on("error", listener);
    },
    removeErrorListener(listener) {
      worker.off("error", listener);
    },
    terminate() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        worker.once("exit", finish);
        try {
          Promise.resolve(worker.terminate()).then(finish, finish);
        } catch {
          finish();
        }
        setTimeout(finish, 2000);
      });
    },
  };
}
