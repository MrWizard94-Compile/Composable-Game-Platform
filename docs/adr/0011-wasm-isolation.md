# ADR 0011 — Isolated WebAssembly guests

**Status:** Accepted. The in-process backend is unchanged and still not a sandbox.

## Decision

Discovery reads `manifest.json` and, if present, the raw bytes of `module.wasm`. It does not import `module.ts` and it does not compile or instantiate a guest. Loading a JavaScript implementation is a separate call, used only for the trusted in-process backend.

`wasm-isolate` is an execution backend. Each module is a worker with its own WebAssembly instance. The host blocks on `Atomics.wait` for that call and `worker.terminate()`s the isolate when the time limit expires. Guest memory must declare a maximum at or below `maxMemoryBytes`. Imports are parsed and refused before instantiation. The guest never receives a filesystem, network, or operating-system handle. Module-to-module values cross as copied JSON through the ABI in `docs/abi.md`.

A save slice is that JSON. It does not contain the guest memory or the backend. A slice captured from one isolate restores into a new isolate, and the same JSON restores into an in-process module of the same save major.

## Consequences

A looping guest is stopped. A guest that imports WASI or `node:fs` never runs. A guest cannot read another guest's memory. The in-process backend remains available only when the policy allows its grants, and it still cannot enforce these limits. Capability strings are enforced for WASM imports. They are still not a sandbox for in-process JavaScript.
