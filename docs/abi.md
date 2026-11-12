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

Register may return `{ "contributions": [{ "slotId", "id", "payload", "dispatch": true }] }`. `dispatch: true` means a later call comes back through hook `5`. The payload the other modules see is an ABI handle, not a live object.

The only import the host will link is `cgp.abi.log` `(ptr, len)`, and only when the manifest lists `cgp.log` and the policy's `allowCapabilities` includes it. `wasi_snapshot_preview1`, `node:fs`, and every other import are refused before the guest runs.

The in-process backend does not speak this ABI. It is an explicit opt-in that still cannot enforce these limits.
