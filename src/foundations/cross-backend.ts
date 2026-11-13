import { inProcessBackend, type ExecutionBackend, type ExecutionPolicy, type ExecutionSession, type HookCall } from "./backend.ts";

/**
 * One composition, two backends.
 * WebAssembly bytes go to the isolating backend. JavaScript hooks go to the trusted one.
 * Grants are the trusted backend's grants. `enforcesLimits` is true because the isolate
 * enforces time, memory, and aggregate budgets. JavaScript on the trusted half is still not limited.
 */
export const CROSS_POLICY: ExecutionPolicy = {
  allowGrants: ["filesystem", "network", "os"],
  maxHookMs: 1000,
  maxMemoryBytes: 65536,
};

function hasWasm(implementation: unknown): boolean {
  return (
    !!implementation &&
    typeof implementation === "object" &&
    (implementation as { wasm?: unknown }).wasm instanceof Uint8Array
  );
}

export function createCrossBackend(isolate: ExecutionBackend, trusted: ExecutionBackend = inProcessBackend): ExecutionBackend {
  return {
    id: "cross",
    grants: trusted.grants,
    enforcesLimits: true,
    configure(policy) {
      isolate.configure?.(policy);
      trusted.configure?.(policy);
    },
    recognizesPayload(payload) {
      return isolate.recognizesPayload(payload) || trusted.recognizesPayload(payload);
    },
    hasHook(implementation, hook) {
      if (hasWasm(implementation)) return isolate.hasHook(implementation, hook);
      return trusted.hasHook(implementation, hook);
    },
    open() {
      const isolated = isolate.open();
      const local = trusted.open();
      let released = false;
      const session: ExecutionSession = {
        id: `cross-${isolated.id}`,
        invoke(call: HookCall) {
          return (hasWasm(call.implementation) ? isolated : local).invoke(call);
        },
        callPayload(payload, args) {
          const target = isolate.recognizesPayload(payload) ? isolated : local;
          return target.callPayload(payload, args);
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await isolated.release();
          } finally {
            await local.release();
          }
        },
      };
      return session;
    },
  };
}
