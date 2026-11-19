# CGP Study 012 — Wasm Package Resource ABI and Memory Ownership

**Research date:** 2026-11-19
**Research baseline:** `main` at `ac9736f` (JavaScript activation refused unless cleanup can pin the directory; Study 011 JavaScript view implemented)
**Decision status:** Recommended. Not implemented. This study does not change the package format, the lock schema, the ABI allowlist, the guest runtime, or any execution backend.

## Problem

Study 011 keeps the verified bytes of one package tree and gives opted-in JavaScript an opaque `openResources` view. A Wasm guest still cannot read those bytes. The only linked import is `cgp.abi.log`. The guest has no store path, no WASI, and no filesystem import, and this study does not add any of those.

The missing capability is one synchronous import that copies a file from that guest's own verified snapshot into memory the guest already owns. The copy is bounded by the guest's declared memory maximum. The host does not grow that memory and does not allocate a host buffer sized to the guest's requested capacity.

## Existing architecture

### Where the bytes live

`scanDirectory` in `src/packages/package-directory.ts` reads every regular file under the package limits in `PACKAGE_RESOURCE_LIMITS`: 4096 files, 64 MiB per file, 128 MiB total, 240 UTF-8 bytes per path, 16 components. `validatePackagePaths` rejects absolute paths, `..`, backslashes, empty components, case-fold collisions, and the other `cgp.package-path/1` failures. The scan does not follow symlinks. `computePackageTreeDigest` hashes those exact bytes as `cgp.package-tree/1`.

`snapshotReleasePackageDirectory` keeps every scanned buffer on `ReleasePackageSnapshot.files`. `artifactBytes` is one of those buffers, not a second copy of the artifact. `packageBytes` is the tree total already included in `maxSnapshotBytes`. `snapshotProjectLock` puts that array on `ProjectModuleSnapshot.files`. `activateProject` uses it for JavaScript `openResources` only. A Wasm module in that same project is passed `{ wasm: artifactBytes }` and is not offered the map.

`snapshotWasmReleasePackageDirectory` verifies the same tree, then returns `wasmBytes` and `packageBytes` only. The non-artifact buffers are discarded after the digest check. `activateWasmProject` therefore has no resource map to give a guest today. The byte budget still counts the whole tree, because `packageBytes` is the total.

The composition lease is the GC root. The store reader ends when the snapshot exists. JavaScript views are invalidated after Foundations shutdown and before backend disposal. Guest shutdown hooks run inside that Foundations shutdown, while the worker is still alive.

### Where an import is refused

The same allowlist is enforced three times. All three currently accept only `cgp.abi.log`, and only when the matching grant is present at that layer.

| Layer | Where | What it sees | What it does not see |
|---|---|---|---|
| Package validation | `validateWasm` in `src/packages/package-directory.ts` | The binary's imports, via `inspectWasm`, and `manifest.permissions` | The execution policy. A package can be valid and still be refused at activation. |
| Host policy | `refuseBinary` in `src/foundations/wasm-isolate.ts`, called from `loadGuest` before the worker is spawned | `inspectWasm`, the manifest permissions, and `policy.allowCapabilities` captured on the isolate | The worker. Refusal here happens before `spawn` and before `postMessage`. |
| Worker | `assertGuestBinary` in `src/foundations/wasm-guest-runtime.mjs`, called at the start of `op: "load"` | The raw bytes and `record.allowLog === true` | The manifest and the policy object. It trusts the boolean the parent computed. |

`loadGuest` sets that boolean only when both sides agree:

```text
allowLog = permissions.includes("cgp.log") && captured.allow.has("cgp.log")
```

`performCall` then posts `{ op: "load", wasm, allowLog, maxBytes, maxBinaryBytes, ... }`. A guest cannot set `allowLog`. The worker is host code. The same pattern must be used for the resource grant. A message forged inside the host could still set the flag; that is the existing `cgp.log` trust boundary, not a guest channel. The worker must still refuse the import when the flag is false, and it must refuse a resource import when no snapshot map was attached even if the flag is true.

`inspectWasm` records imports, one memory, and at most one table. It does not record a start section. Section id 8 is skipped. Imported memory, shared memory, memory64, a missing memory maximum, and a table maximum above 256 are refused. The worker repeats those checks. `WebAssembly.Module` in package validation compiles but does not instantiate.

### How the import object is built

`createGuestRuntime` instantiates only after `assertGuestBinary`. The loop that builds the import object is:

```javascript
for (const item of imports) {
  if (item.module !== "cgp.abi" || item.name !== "log" || item.kind !== "function") {
    throw new Error(`Unauthorized import ${item.module}.${item.name}`);
  }
  importObject["cgp.abi"] = { log(ptr, len) { ... } };
}
instance = new WebAssembly.Instance(mod, importObject);
memory = exported.memory;
```

Assigning `importObject["cgp.abi"]` inside the loop replaces the whole namespace on every import. With only `log` that is harmless. A second function on `cgp.abi` would leave whichever import was seen last. The implementation must build one `cgp.abi` object and add `log` and `resource_read` onto it. Both must be present when the module imports both.

`log` is `(ptr: i32, len: i32) -> ()`. The worker reads guest memory with `copyOut`, which treats both arguments as unsigned (`>>> 0`) and rejects `start + size` past `memory.buffer.byteLength`. A bad pointer throws. That throw fails the hook, and the isolate then stops the guest. `log` has no status code to return.

### When memory does not exist yet

`new WebAssembly.Instance` runs a start function before the constructor returns. The runtime stores `exported.memory` only after that return. A start function that calls `log` today hits `copyOut` while `memory` is still null and throws `Guest has no memory.` Instantiation fails. The host never observes a successful load.

That accident is not a safe resource rule. The import must not dereference `memory` when it is null, and a resource-capable module must not rely on a start function to discover the failure.

`copyOut` and the hook input path both read `memory.buffer` at the moment of the call. `WebAssembly.Memory.buffer` returns the current `ArrayBuffer` after `memory.grow`. An old view is detached. The resource import must not cache `memory.buffer` at load time. It also must not call a guest export, so the guest cannot grow memory while the host is writing.

Node and Chromium share `createGuestRuntime`. `src/foundations/wasm-worker.mjs` and `src/foundations/wasm-worker-browser.mjs` are thin ports over it. Browser activation of stored packages is not implemented. `createBrowserWasmBackend` spawns a worker and never attaches a package snapshot. `createWasmBackend` can set `resourceLimits` on the Node worker. The browser backend refuses `isolateHeapMb` because a page cannot cap a worker heap. The host does not call `Atomics.wait`. Guest calls are messages. An import function itself is synchronous.

### Activation order

`activateProject` and `activateWasmProject` both verify the lock, take one composition lease, and snapshot under `maxSnapshotBytes` before any guest starts. Shutdown order is Foundations shutdown, JavaScript resource invalidation, Wasm backend disposal, removal of owned JavaScript copies, then lease release. Guest shutdown is hook `2` and runs in the first step, while the worker is alive. Disposal terminates the worker. JavaScript activation on Windows and macOS is refused before the lease when the platform cannot pin the activation directory. Wasm-only activation does not create that directory and is not refused for that reason.

`ModuleImplementation` in Foundations is `{ wasm?: Uint8Array, ...hooks }`. `RegisterContext` and `LifecycleContext` do not carry package bytes. `createCrossBackend` forwards the same implementation object to the isolate when `wasm` is a `Uint8Array`. A structural field on that object reaches `loadGuest` without a new context type. JavaScript `openResources` must stay a package-layer method and must not become a guest import.

## Names

Use the same split `cgp.log` already uses.

| Surface | Name |
|---|---|
| Manifest `permissions` entry | `cgp.resource.read` |
| `allowCapabilities` entry | `cgp.resource.read` |
| Import module | `cgp.abi` |
| Import field | `resource_read` |

`cgp.resource.read` matches `MODULE_ID_RE` in `src/foundations/manifest.ts` (`cgp.log` already does). No manifest schema change is required to store the string. The runtime must recognize that exact string. Any other permission still grants nothing.

`resource_read` is one field, next to `log`. A dotted field such as `resource.read` would still be a single Wasm name, but it invents a second naming style inside `cgp.abi`. `cgp.resource` without `.read` is too wide: a later write import must not ride on the read grant.

The package descriptor stays `abi: "cgp.abi/1"`. The JSON handle marker stays `{ "abi": "cgp.abi/1", ... }`. Adding an optional import does not break a guest that imports nothing or imports only `log`. Bump the ABI generation only if a later change alters `log`, hook numbers, or the result encoding. Do not bump it for this import.

## ABI contract

One import. Guest-side signature:

```wat
(func (import "cgp.abi" "resource_read")
  (param $path i32)
  (param $path_len i32)
  (param $out i32)
  (param $out_cap i32)
  (param $written i32)
  (result i32))
```

`path` / `path_len` are the UTF-8 package-relative key. `out` / `out_cap` are the destination. `written` is the address of an `i32` where the host stores a length. All five parameters are Wasm `i32`. The host treats each as unsigned with `>>> 0` before any arithmetic. A negative JS number from the high bit is not a negative length.

The import is synchronous. It does not post a message and does not wait on the parent. The bytes are already in the worker, or the call fails.

### Status codes

| Result | Name | Bytes written to `out` | `*written` |
|---|---|---|---|
| 0 | `OK` | The entire file, or nothing if the file is empty | File length, including 0 |
| 1 | `TOO_SMALL` | Nothing | Exact file length |
| 2 | `NOT_FOUND` | Nothing | Not written |
| 3 | `BAD_PATH` | Nothing | Not written |
| 4 | `BAD_RANGE` | Nothing | Not written |
| 5 | `UNAVAILABLE` | Nothing | Not written |

Ordinary resource failures return a status. They do not throw. A throw aborts the Wasm call, fails the hook, and stops the guest, which is what `log` does on a bad pointer because `log` has no result. `resource_read` has a result, so a bad guest pointer stays a status. Host invariant failures may still throw. The import must not call `cg_hook` or any other guest export.

`OK` means the capacity was sufficient and the full file was copied. An empty file with `out_cap >= 0` is `OK`, `*written = 0`, and the destination is not touched. `out` is not required to be in range when no destination bytes are written.

`TOO_SMALL` means the key exists and `out_cap` is smaller than the file. The host writes the required length and does not write the destination, even one byte. A size query is this call with `out_cap = 0` and any `out`, including 0. An empty file does not take that path: capacity 0 is enough, so the result is `OK` and `*written` is 0. A non-empty file returns `TOO_SMALL` and `*written` is the length. The guest can tell those apart. There is no second import.

`NOT_FOUND` is a path that passes `validatePackagePaths` and is not a key in this guest's map. `BAD_PATH` is anything else: invalid UTF-8, a length above 240 bytes, an empty path, an absolute path, `..`, a backslash, a percent-encoded segment, a different case, or any other string `validatePackagePaths` rejects. The host does not decode, case-fold, or normalize. It does not search the store.

`BAD_RANGE` is a pointer or length that is outside the current memory, or that would overflow the unsigned range check. `UNAVAILABLE` is a missing memory export at the moment of the call, a missing resource map, or a map that has been dropped. The browser case below is `UNAVAILABLE` at instantiate time as well, so a browser guest should not get as far as the call.

### Check order

1. If `memory` is null, or the module has no resource map, return `UNAVAILABLE`. Do not read guest memory.
2. Read `memory.buffer` once for this call. If it is detached or not an `ArrayBuffer`, return `UNAVAILABLE`.
3. Range-check `written` for 4 bytes using the subtraction form below. On failure return `BAD_RANGE` and write nothing.
4. If `path_len > 240`, return `BAD_PATH` and write nothing. Do not allocate a path buffer of the guest's claimed length.
5. If `path_len > 0`, range-check the path. On failure return `BAD_RANGE` and write nothing. If `path_len` is 0, return `BAD_PATH` without reading `path`.
6. Copy the path bytes out. Decode UTF-8 with a fatal decoder. Replacement characters are not a successful decode. Invalid UTF-8 is `BAD_PATH`.
7. If `validatePackagePaths` rejects the string, return `BAD_PATH`. Look up the exact string. A miss is `NOT_FOUND`.
8. Let `n` be the file's byte length. If `n > out_cap`, write `n` to `written` as a little-endian `u32` and return `TOO_SMALL`. Do not read or write `out`.
9. If `n > 0`, range-check `out` for `n` bytes. On failure return `BAD_RANGE` and do not write `written` either.
10. Copy all `n` bytes into `out`, then write `n` to `written`, then return `OK`. A zero-length file skips the destination copy and still writes 0.

The destination range is checked before either write. There is no partial copy. The host does not call `memory.grow`. It does not allocate a `Uint8Array` of length `out_cap`. The copy is `new Uint8Array(buffer, out, n).set(fileBytes)` for the exact file length, into memory the guest already has.

### Unsigned range check

For a pointer `start` and a byte length `size`, after both have been converted with `>>> 0`:

```text
size > buffer.byteLength || start > buffer.byteLength - size
```

This is the form that stays correct when `start + size` would wrap a 32-bit add. Two Wasm `i32` values fit in a safe JS integer, but the subtraction form is the one to implement so a later `i64` or a larger limit does not inherit a wrapping add. A destination that ends on the last byte of memory is in range: `start + size === buffer.byteLength` passes. `written` uses `size = 4`.

`*written` is little-endian so a guest that loads it with a Wasm `i32` load sees the same integer. Alignment is not required. `DataView.setUint32(written, n, true)` accepts an unaligned address.

## Start function

Refuse a module that imports `cgp.abi.resource_read` and has a start section (section id 8). Do this in `validateWasm`, `refuseBinary`, and `assertGuestBinary`. `inspectWasm` has to grow a `hasStart` flag; today it skips section 8.

The refusal is before `WebAssembly.Instance`. A start function runs before the host can store `exported.memory`, so the import would otherwise observe a null memory. Returning `UNAVAILABLE` from that call is the callback's backstop if a binary still reaches it, and the callback must not touch `instance.exports` or `memory.buffer` in that state. It is not the admission rule. A guest must not be instantiated and then expected to ignore status 5 during start.

`log` already throws if a start function calls it. This study does not change `log`.

## Transport

The worker cannot ask the parent during the import. The map has to be in the worker before `WebAssembly.Instance`, or the import is not linked.

### A. Structured clone on the load message (recommended)

`loadGuest` already posts the artifact as `wasm: Uint8Array`. Add a `resources` value only when this guest's binary imports `resource_read` and both grants are present: a dictionary of exact package paths to the scanned `Uint8Array` views for that one package. Do not put the dictionary in the `postMessage` transfer list.

Node `worker_threads` and a browser `Worker` both structured-clone a `Uint8Array` by copying the view's bytes into a new `ArrayBuffer` in the receiver. The parent view stays usable. That matters because the scanned buffers may be `Buffer` views over a pool slab. Transferring that slab can throw, or detach memory the parent still needs. Cloning the view copies `byteLength` bytes, not the whole pool.

The parent keeps its snapshot until the existing invalidation step, which is after Foundations shutdown and before `dispose`. The worker's clone lives until the worker is terminated, which is disposal, after shutdown hook `2`. Guest shutdown can read. After disposal the map is gone with the worker. A failed `postMessage` leaves the parent buffers attached. `loadGuest` already refunds the reservation and calls `stopGuest` when start or load fails. `stopGuest` terminates the worker, which drops the clone. There is no transferred buffer to put back.

### B. Transfer the parent's ArrayBuffers (rejected)

Transferring the snapshot buffers would avoid a second resident copy, and it is the wrong ownership model here.

- The parent bytes are often Node `Buffer` views. Their backing store is not a safe transfer.
- Mixed activation still needs the parent bytes. JavaScript `openResources` reads them through shutdown hooks. Transfer detaches that view.
- `postMessage` detaches when it accepts the transfer list. If the worker then fails `assertGuestBinary` or instantiation, the parent no longer has the bytes and the worker is about to be terminated. Cleanup cannot reconstruct them without reading the store again, which this design forbids.
- Guests are not restarted after `stopGuest`. A later retry of activation would have to snapshot again anyway. That does not make a detached failure path acceptable.

Copying into a fresh `ArrayBuffer` and transferring that copy is one copy, same as a structured clone, plus a detach step that clone does not need. It is not a better first implementation.

### C. Ask the parent, or bake the files into the binary (rejected)

A synchronous import cannot round-trip to the parent. The host does not call `Atomics.wait`, and the worker message channel is asynchronous. Shared memory is already refused.

Embedding the files in a Wasm data segment would change `module.wasm`, change the artifact digest, and still leave the guest to know every offset. The package-tree digest already names the files. A second copy inside the binary is a format change, not an import.

WASI preview 1 and any host filesystem import stay refused.

### What the extra copy costs

`maxSnapshotBytes` already includes `packageBytes` for every locked module. Retaining the wasm-only file buffers does not add a second number to that budget. It does keep RAM that `snapshotWasmReleasePackageDirectory` currently drops. That retention is required only for a guest that imports `resource_read`. A guest that does not import it keeps today's wasm-only snapshot shape.

The worker clone is additional host memory. It is not guest linear memory and it is not part of the declared-memory reservation. Bound it by sending only that guest's own files, and only when the import will be linked. The ceiling is the package limit: 128 MiB for the tree, 64 MiB for one file, 4096 files. The artifact is already cloned as `wasm` on the same message, and it is also in the map if the guest is allowed to read `module.wasm`. That transient second copy of the artifact is accepted. Omitting it would make the guest's tree differ from the digest.

Node may apply `isolateHeapMb` / `resourceLimits` to the worker process. That cap is optional and is not a substitute for the package limits. The browser cannot apply it. Do not raise `maxMemoryBytes` so a file will fit. If the guest's current memory is smaller than the file, the result is `TOO_SMALL` with no growth and no host allocation of `out_cap` bytes.

The parent still holds the project snapshot for the JavaScript view in a mixed activation. A mixed project therefore has the parent copy of each package plus, for a Wasm guest that imports the capability, one worker copy of that guest's package. JavaScript-only projects do not send a worker map. The lease stays the GC root. No reader marker is held for the composition.

## Permission and policy

Link `resource_read` only when all three are true:

1. The manifest `permissions` array contains `cgp.resource.read`.
2. The active policy `allowCapabilities` contains `cgp.resource.read`.
3. This guest has a resource map from its own verified snapshot.

Data files in the package do not grant the import. A manifest permission without the policy grant is refused. A policy grant without the manifest permission is refused. Both grants with no attached map are refused. That last case is the browser backend today, and it is also a Node session that loads a raw `module.wasm` outside activation.

`loadGuest` computes `allowResource` the same way as `allowLog`, then still omits the map unless it has one. The worker refuses the import when `allowResource !== true`. It also refuses the import when the map is absent, before `WebAssembly.Instance`. A raw load message that sets `allowResource: true` and attaches no map must not link the function. That is the fail-closed rule. The parent remains the only component that can attach a map, and it attaches only the one package's scanned files.

`validateWasm` checks the manifest side only, as it does for `cgp.log`. Policy is not known when a package is packed. `refuseBinary` checks both grants and the start section. `assertGuestBinary` checks the parent's boolean, the start section, and, once the map is part of the message, the worker refuses to build the function if the map is missing.

Expected refusal strings, so the three layers can be tested without scraping a stack:

| Condition | Where | Result |
|---|---|---|
| Import is not `cgp.abi.log` or `cgp.abi.resource_read` | All three | Unauthorized import, before instantiation |
| `resource_read` without manifest permission | Package validation and `refuseBinary` | Not granted |
| `resource_read` without policy grant | `refuseBinary` before spawn | `Capability cgp.resource.read is not granted.` |
| `resource_read` with both grants and no map | Worker, before `Instance` | Not available; do not link |
| `resource_read` and a start section | All three | Refused before instantiation |
| `log` and `resource_read` together, both granted, map present | Worker | Both functions on one `cgp.abi` object |

A module that imports neither function stays valid. Existing `cgp.abi/1` guests stay valid.

## Browser and platforms

Windows and macOS can run this import. It does not use the JavaScript activation directory, so Study 010's refusal of JavaScript on those platforms stays as it is. `activateWasmProject` of a wasm-only lock is the path that must work on Linux, Windows, and macOS. A mixed lock still refuses JavaScript before a lease on Windows and macOS, which means that mixed lock does not start there. The Wasm half is not given a special exception that would also import JavaScript.

The browser worker shares the guest runtime and has no verified snapshot. `resource_read` is refused before instantiation even when the manifest lists `cgp.resource.read` and the browser policy lists it too. The browser backend must not open a filesystem, a file URL, or a store path. A later slice can send the same verified records over a bounded channel. That transport is not this study.

## Lifecycle

`activateProject` and `activateWasmProject` both need the map available to a permitted guest.

- Wasm-only: extend the in-memory wasm snapshot to retain `files` when at least one locked module imports `resource_read`. This is not a new digest and not a catalog change. `packageBytes` is unchanged. Modules that do not import the capability can keep the current wasm-only snapshot shape.
- Mixed: `ProjectModuleSnapshot.files` already exists. Pass that guest's files through. Do not pass the other package's files. JavaScript `openResources` is unchanged and still does not see the Wasm package unless it is that JavaScript module's own tree.
- JavaScript-only: no Wasm import, no worker map, no change to `openResources`.

The package layer may set a structural field on the implementation object that already carries `wasm`. `createCrossBackend` forwards that object. Do not add the map to `RegisterContext`, `LifecycleContext`, or the public `ModuleImplementation` type in the first slice. The isolate reads the field only after `refuseBinary` has accepted the import. If the import is accepted and the field is missing, refuse before spawn returns a loaded guest.

Shutdown hook `2` runs before resource invalidation and before disposal, so the worker map is still there. Invalidation drops the parent JavaScript views. Disposal terminates the worker and drops the clone. The lease is still held across both. `already: true` stays the existing rule: only after those steps have succeeded. A throw from worker construction refunds the reservation and terminates the worker. Because the parent buffers were not transferred, that failure does not destroy the snapshot. A throw while posting the load message does the same.

## Memory edge cases

| Case | Required behavior |
|---|---|
| `i32` with the high bit set | Treat as unsigned. Do not reject a pointer merely because the JS value is negative. |
| `path_len` of 0 | `BAD_PATH`. Do not read `path`. |
| `out_cap` of 0 and an empty file | `OK`, write 0 to `written`, do not read `out`. |
| `out_cap` of 0 and a non-empty file | `TOO_SMALL`, write the length, do not read `out`. |
| Output ends on the last memory byte | In range. Copy succeeds when the file fits. |
| Output would pass the last byte | `BAD_RANGE` before any write. |
| `written` would pass the last byte, or has fewer than 4 bytes | `BAD_RANGE`. Do not write the destination. |
| File larger than the declared memory maximum | `TOO_SMALL` if the guest's capacity is short. Do not grow memory. Do not allocate `out_cap` on the host. |
| File at the 64 MiB package limit | Same rule. The host already holds the scanned bytes. |
| Guest calls `memory.grow` before the import | Read `memory.buffer` at the start of this call. Do not reuse a view from a previous hook. |
| Guest calls `memory.grow` during the import | Cannot happen if the import does not call the guest. Do not call the guest. |
| Start function calls the import | Module refused before instantiation. Callback returns `UNAVAILABLE` if it is ever entered with null memory. |
| Re-entrant `resource_read` from `log` or from a guest export | `log` does not call the guest. This import must not either. |
| Shared or imported memory | Still refused. Unchanged. |

## Conformance tests

These tests are the contract for the implementation slice. None of them are added by this study.

Guest reads:

- A permitted guest reads a data file and the bytes match the package-tree snapshot.
- Changing that file changes the package-tree digest and the project lock, not the artifact digest.
- An empty file returns `OK` and length 0.
- `out_cap = 0` on a non-empty file returns `TOO_SMALL` and the exact length, and the destination is unchanged.
- A short non-zero capacity returns `TOO_SMALL` and does not write a prefix.
- A buffer that ends exactly at the end of memory succeeds when the file fits.
- The guest reads `module.wasm` and gets the artifact bytes that were hashed.
- `cgp.abi.log` still works. A module that imports `log` and `resource_read` links both, and calling one does not remove the other.
- An existing guest that does not import `resource_read` still loads.

Refusal before instantiation:

- An unknown import is refused.
- Manifest permission without `allowCapabilities` is refused, and no worker is left running.
- `allowCapabilities` without the manifest permission is refused.
- A browser guest, or any guest with no attached map, is refused even if both names are present.
- A start section plus `resource_read` is refused, and the callback is not entered.
- Package validation accepts the permission only as the exact string, and still does not apply the execution policy.

Path and pointer failures, after a permitted guest is running:

- Missing key returns `NOT_FOUND`.
- Invalid UTF-8, empty path, absolute path, `..`, backslash, percent-encoded dot segment, and a different case return `BAD_PATH` and do not write.
- A path length above 240 returns `BAD_PATH` without allocating that many host bytes.
- An out-of-range path pointer or `written` pointer returns `BAD_RANGE` and does not write the other buffer.
- Another package's path is `NOT_FOUND` or `BAD_PATH`. It is never a successful read. The guest has no argument for a package digest.

Lifecycle and budgets:

- Snapshot budget failure throws before any guest starts and releases the lease.
- One bad package prevents an earlier guest from starting.
- An unrelated unpinned object can be collected while the lease is held.
- The leased object's resource bytes do not change if the store object is rewritten after the snapshot.
- A read from shutdown hook `2` succeeds.
- After backend disposal, the worker is gone and a further read is impossible.
- Worker `spawn` failure, `postMessage` failure, instantiation failure, and disposal failure leave no detached parent buffers and do not report the lease released.
- JavaScript `openResources` behavior from Study 011 is unchanged.
- Windows and macOS still refuse JavaScript activation before a lease. Wasm-only activation, including a permitted resource read, still runs there.
- The host does not call `memory.grow` for a read. A guest that grows and then reads sees the new memory, not a detached view.

## Implementation phases

1. **This study.** No runtime change.
2. **Allowlist agreement.** Teach `inspectWasm` about the start section. Teach `validateWasm`, `refuseBinary`, and `assertGuestBinary` the new names and the start refusal. Build one `cgp.abi` object. Existing guests stay green. No successful read yet.
3. **Worker map and status codes.** Retain wasm-only files in memory when the import is present. Structured-clone that one package on `op: "load"`. Implement the check order above. Do not transfer parent buffers.
4. **Activation.** Wire `activateProject` and `activateWasmProject`. Keep JavaScript `openResources`. Cover shutdown, disposal, and the failure-injection cases.
5. **Not this work.** Browser transport, WASI, a filesystem import, cross-package reads, a new digest, an ABI version bump, a native addon, and any weakening of the JavaScript platform refusal.

## Non-goals

- No change to `cgp.package-tree/1`, `cgp.package-path/1`, the lockfile, or the catalog.
- No `cgp.abi` version bump.
- No write import and no `cgp.resource` grant that implies write.
- No WASI, no store path, no file URL, and no host directory in the worker.
- No `Atomics.wait` and no asynchronous import.
- No host-driven `memory.grow` and no host buffer sized to `out_cap`.
- No claim that JavaScript is sandboxed, and no change to where JavaScript activation is refused.
- No browser loader for stored packages.

## Unresolved

These are narrow. They do not block the recommendation above.

- Whether a later write import should be `cgp.abi.resource_write` with `cgp.resource.write`, or should stay out of `cgp.abi/1` entirely. This slice does not add it.
- Whether `isolateHeapMb` should grow automatically by the cloned tree size. Recommendation for the first slice: no. The package limits and the existing worker cap stay independent, and a file that does not fit in guest memory is `TOO_SMALL` rather than a larger heap.
- Whether wasm-only snapshots should always retain `files`, or only when `resource_read` is imported. Recommendation: only when the import is present, so guests that do not read pay today's memory cost. The scan still has to see the import list, which `validateWasm` already does.
