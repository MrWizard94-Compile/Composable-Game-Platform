# ADR 0011 — Isolated WebAssembly guests

**Status:** Accepted. The in-process backend is unchanged and still not a sandbox.

## Decision

Discovery reads `manifest.json` and, if present, the raw bytes of `module.wasm`. It does not import `module.ts` and it does not compile or instantiate a guest. Loading a JavaScript implementation is a separate call, used only for the trusted in-process backend.

`wasm-isolate` is an execution backend. `open` starts one composition. Each module in that composition is a worker with its own WebAssembly instance. The workers and their memories belong to that composition. `release` terminates them. A second composition, including another version of the same module id, gets its own workers. The host does not call module functions itself, and it does not block the main thread: each guest call is a promise. A timer calls `worker.terminate()` when the time limit expires, including when the guest loops inside its start function.

Guest memory must declare a maximum at or below `maxMemoryBytes`. The binary is not instantiated until that check, and the worker repeats it. Shared memory, 64-bit memory, imported memory, and more than one memory are refused. A table, if present, must be one unshared table with a maximum of at most 256 entries. The guest never receives a filesystem, network, or operating-system handle. The worker's heap, young generation, code range, and stack are capped. Module-to-module values cross as copied JSON through the ABI in `docs/abi.md`.

A save slice is that JSON. It does not contain the guest memory or the backend. A slice captured from one isolate restores into a new isolate, and the same JSON restores into an in-process module of the same save major.

## Consequences

A looping guest is stopped, and another composition can still run while that happens. A guest that imports WASI or `node:fs` never runs. A guest cannot read another guest's memory. Shutting one composition down does not release another. The in-process backend remains available only when the policy allows its grants, and it still cannot enforce these limits. Capability strings are enforced for WASM imports. They are still not a sandbox for in-process JavaScript.
