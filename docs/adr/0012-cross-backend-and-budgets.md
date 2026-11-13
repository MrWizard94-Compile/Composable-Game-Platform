# ADR 0012 — Cross-backend execution and aggregate budgets

**Status:** Accepted. The in-process backend is still not a sandbox. ADR 0010's closing line is historical: an isolating backend now exists, and this record is the one that routes it.

## Decision

A composition has one session. `createCrossBackend(isolate, trusted)` opens one session on each backend. WebAssembly bytes are invoked on the isolate. JavaScript hooks are invoked on the trusted backend, which defaults to in-process. A payload the isolate recognizes (an ABI handle) is called there. Anything else goes to the trusted session. `release` releases both.

`enforcesLimits` on the cross backend is true, because the isolate enforces time, memory, import, and aggregate budgets. The grants are the trusted backend's grants. JavaScript contributions in that composition are still not limited. A policy that sets a limit still refuses a backend whose `enforcesLimits` is false, so the in-process backend alone cannot wear `CROSS_POLICY`.

Aggregate budgets are optional policy fields: `maxGuests`, `maxTotalMemoryBytes`, `maxTotalBinaryBytes`, and `maxTotalHookMs`. Unset means unlimited. They apply to the composition that snapshotted them at `open`, not to every composition sharing the backend. A later `configure` writes them again, including when they are absent, so a tighter budget does not leak into the next composition. The isolate charges a guest after it has passed the binary checks and refunds that charge if instantiation fails. Hook time is wall-clock time spent in the guest call. Once the spent time reaches `maxTotalHookMs`, further calls return `Composition hook budget exceeded.`

`shutdown` is one promise. A second call waits for that promise and then reports `{ already: true, order: [], diagnostics: [] }`. Each module's shutdown is caught. One failure does not skip the modules after it. `session.release()` runs in a `finally`, so a thrown hook still terminates the workers.

A guest may nest `{ "dispatch": true }` as the only key of an object inside its register payload. That object becomes an ABI handle for the contribution. A top-level `dispatch: true` still replaces the whole payload. Slot dispatch calls either form through the session. It does not call a guest export directly.

## Consequences

One composition can hold a JavaScript package and a guest. Dune Growth is the first guest that computes a policy. It stays out of the default proof so it does not collide with the other growth policy. The template at `examples/wasm-module` is the copyable guest. `scripts/verify-wasm.ts` and the foundations workflow compare those bytes to the generators on Node 22.

The browser console uses the same cross routing when a selected package carries wasm bytes. That page cannot open a Node worker, so it uses a browser worker with the same ABI. The Node isolate remains the backend the tests verify, including refusal before instantiation and the aggregate budgets.
