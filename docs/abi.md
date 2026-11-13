# Module ABI `cgp.abi/1`

A portable module is a WebAssembly binary. The host copies UTF-8 JSON in and copies UTF-8 JSON out. It does not share the guest memory with another module or with the host's objects.

The guest exports:

| Export | Signature | Role |
| --- | --- | --- |
| `memory` | pages of 65536 bytes, with a maximum | Private linear memory. No maximum, or a maximum above the policy, is refused before instantiation. |
| `cg_alloc` | `(n: i32) -> i32` | Space for the host's input. `0` means the guest cannot take those bytes. |
| `cg_hook` | `(hook: i32, ptr: i32, len: i32) -> i32` | `0` on success. Any other status is a failure. The message is the output bytes. |
| `cg_out_ptr` | `() -> i32` | Start of the result. |
| `cg_out_len` | `() -> i32` | Length of the result. Empty means `undefined`. |

Hook numbers: `0` register, `1` initialize, `2` shutdown, `3` exportState, `4` importState, `5` call.

Register may return `{ "contributions": [{ "slotId", "id", "payload", "dispatch": true }] }`. `dispatch: true` on the contribution replaces the payload with an ABI handle `{ "abi": "cgp.abi/1", "moduleId", "contributionId" }`. The same marker nested in the payload, as an object whose only key is `dispatch`, becomes a handle in place. Other fields stay JSON. A later call is hook `5`. The input JSON is `{ "contributionId", "arg", "args" }`. The output is JSON. Empty output is `undefined`.

The only import the host will link is `cgp.abi.log` `(ptr, len)`, and only when the manifest lists `cgp.log` and the policy's `allowCapabilities` includes it. `wasi_snapshot_preview1`, `node:fs`, and every other import are refused before the guest runs. Shared memory, 64-bit memory, and a missing memory maximum are refused. A table must declare a maximum of at most 256 entries.

The host does not run the guest on its own thread and does not block that thread. Each composition owns the workers it opens. `release` resolves after those workers have been terminated, including a worker that was still loading and including when shutdown throws. A reservation is refunded once. `shutdown` is single-flight. `dispose` ends every session on that backend. Two compositions do not share a guest, even when they load the same module id at different versions. Aggregate budgets (`maxGuests`, `maxTotalMemoryBytes`, `maxTotalBinaryBytes`, `maxTotalHookMs`) are per composition. Host ceilings are per backend. Host memory is the sum of declared linear-memory maxima, including in-flight loads, and it does not include `isolateHeapMb`. Unset means unlimited. When a hook-time budget is set, that ledger admits one call at a time; an in-flight call can exceed it, and the next call observes the spent time. `cgp.log` output is capped in UTF-8 bytes and stored on the composition that produced it. Completed compositions keep a bounded number of those logs. The browser isolate enforces these same rules. It refuses `isolateHeapMb` because a page cannot cap a worker heap. The Node isolate applies that cap. Copy `examples/wasm-module` or `examples/third-party-module` to start a guest. `scripts/check-wasm-module.ts` instantiates a package that was not built in this repository. `org.cgp.dune-growth` is a guest that contributes a real policy.

The in-process backend does not speak this ABI. It is an explicit opt-in that still cannot enforce these limits. `createCrossBackend` routes ABI handles and wasm bytes to the isolate and JavaScript functions to the in-process backend. The JavaScript half is still not limited. Copy `examples/wasm-module` to start a guest. `org.cgp.dune-growth` is a guest that contributes a real policy.
