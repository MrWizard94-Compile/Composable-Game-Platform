# CGP Study 012 — Wasm Package Resource ABI and Memory Ownership

**Research date:** 2026-11-19
**Revised:** 2026-11-19. Delivery remains one transferred pack per guest. Scanner `Buffer`s are not cloned. `BAD_PATH` is grammar, not a case miss. Overlapping `out` and `written` is `BAD_RANGE`. The index stays an array of `{ path, offset, length }` records; the worker converts those records into `[path, { offset, length }]` pairs before `new Map`, then rejects a malformed index before instantiation. Resource-byte accounting is per activation, not process-wide.
**Research baseline:** `main` at `e4ef0c4` (transport correction recorded; resource import not implemented)
**Decision status:** Phase 1 is implemented. Phase 3's pack and status codes are implemented in the isolate. A guest that imports `cgp.abi.resource_read`, holds both grants, and carries `packageFiles` plus `maxSnapshotBytes` on its implementation gets one exact `ArrayBuffer` of its own files. The parent validates the `{ path, offset, length }` index, transfers that buffer, and does not post the scanner's `module.wasm` `Buffer`. The worker builds `new Map(index.map(({ path, offset, length }) => [path, { offset, length }]))`, validates again, and compiles `module.wasm` from that slice. `resource_read` follows the status check order. A missing pack is refused before instantiation. `activateProject` and `activateWasmProject` do not attach the pack yet.

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

The same allowlist is enforced three times. Phase 1 accepts `cgp.abi.log` and `cgp.abi.resource_read`, and only when the matching grant is present at that layer. Phase 3 copies file bytes when that guest's pack was transferred with the load. A granted import with no pack still does not copy.

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

Assigning `importObject["cgp.abi"]` inside the loop replaces the whole namespace on every import. With only `log` that is harmless. A second function on `cgp.abi` would leave whichever import was seen last. The worker builds one `cgp.abi` object and adds `log` and `resource_read` onto it. When the load carries a validated pack, `resource_read` copies from that pack. When the map is missing it refuses before instantiation with `Package resources are not available.` Both imports stay on that one object when the module imports both.

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

`path` / `path_len` are the UTF-8 package-relative key. `out` / `out_cap` are the destination. `written` is the address of an `i32` where the host stores a length. All five parameters are Wasm `i32`. The host treats each as unsigned with `>>> 0` before any arithmetic. A negative JS number from the high bit is not a negative length. The host and the worker resolve this import's function type only when the module imports `cgp.abi.resource_read`, and they refuse any other shape before instantiation: not five parameters, a parameter that is not `i32`, or a result that is not one `i32`. A missing or out-of-range type index is a malformed binary. Guests that do not import `resource_read` do not have their type section decoded by this check. The runtime's own validator decides those modules, including a type section with more function types than any older preflight cap and a section that uses a WebAssembly 3.0 type form. When `resource_read` is imported, that section is decoded as a WebAssembly 3.0 type section: recursive groups (`0x4E`), final and open subtypes (`0x4F`, `0x50`), function (`0x60`), struct (`0x5F`), and array (`0x5E`) types, numeric and vector value types, abstract reference shorthands, and `ref` / `ref null` heap types. The number of types and the number of parameters are bounded by the type-section size and the existing binary budget, not by a separate 256-type or 128-value cap. A struct or array at the import's type index is the wrong signature. An opcode outside that set, anywhere in that section, is refused before instantiation with `cgp.abi.resource_read uses an unsupported WebAssembly type form.` `cgp.abi.log` is not given a signature check. Its type is decoded only when a `resource_read` import caused the section to be decoded.

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

`NOT_FOUND` is a path whose grammar `validatePackagePaths` accepts and whose exact string is not a key in this guest's map. `BAD_PATH` is a string that is not a package path: invalid UTF-8, a length above 240 bytes, more than 16 components, an empty path, or any string `validatePackagePaths` rejects (absolute, `..`, backslash, a component outside `[A-Za-z0-9._-]`, and the other grammar failures). The host does not decode percent-escapes, does not case-fold, and does not normalize. It does not search the store.

A different case is not `BAD_PATH`. `validatePackagePaths` checks grammar, and case collision only when several paths are validated together. One guest string in a different case is grammatical and then misses the map, so the status is `NOT_FOUND`. Do not pass the guest string together with the package's paths into `validatePackagePaths`. That would turn a case difference into a collision error.

`BAD_RANGE` is a pointer or length that is outside the current memory, or that would overflow the unsigned range check. `UNAVAILABLE` is a missing memory export at the moment of the call, a missing resource map, or a map that has been dropped. The browser case below is `UNAVAILABLE` at instantiate time as well, so a browser guest should not get as far as the call.

### Check order

1. If `memory` is null, or the module has no resource map, return `UNAVAILABLE`. Do not read guest memory.
2. Read `memory.buffer` once for this call. If it is detached or not an `ArrayBuffer`, return `UNAVAILABLE`.
3. Range-check `written` for 4 bytes using the subtraction form below. On failure return `BAD_RANGE` and write nothing.
4. If `path_len > 240`, return `BAD_PATH` and write nothing. Do not allocate a path buffer of the guest's claimed length.
5. If `path_len > 0`, range-check the path. On failure return `BAD_RANGE` and write nothing. If `path_len` is 0, return `BAD_PATH` without reading `path`.
6. Copy the path bytes out. Decode UTF-8 with a fatal decoder. Replacement characters are not a successful decode. Invalid UTF-8 is `BAD_PATH`.
7. If `validatePackagePaths` rejects the string, or the path has more than 16 components, return `BAD_PATH` and write nothing. Look the exact string up in the `Map` built under Transport. A miss is `NOT_FOUND`. Do not use a plain object. `__proto__` and `constructor` match the path-component grammar. Do not pass this guest string together with the index paths into `validatePackagePaths`.
8. Let `n` be the file's byte length. If `n > out_cap`, write `n` to `written` as a little-endian `u32` and return `TOO_SMALL`. Do not read or write `out`. Overlap with `out` does not matter, because `out` is not written.
9. If `n > 0`, range-check `out` for `n` bytes. On failure return `BAD_RANGE` and do not write `written` either. If the half-open ranges `[out, out+n)` and `[written, written+4)` overlap, return `BAD_RANGE` and write neither. Ranges that only touch at an edge do not overlap.
10. Copy all `n` bytes into `out`, then write `n` to `written`, then return `OK`. A zero-length file skips the destination copy and the overlap check, and still writes 0 to `written`.

The destination range is checked before either write. There is no partial copy. The host does not call `memory.grow`. It does not allocate a `Uint8Array` of length `out_cap`. The file bytes are the view `new Uint8Array(pack, offset, length)` from the map hit. The copy is `new Uint8Array(memory.buffer, out, n).set(fileView)` for that exact length, into memory the guest already has.

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

The worker cannot ask the parent during the import. The bytes have to be in the worker before `WebAssembly.Instance`, or the import is not linked. The parent snapshot buffers are not that delivery.

### Confirmed: `readFileSync` buffers are not safe to clone or transfer

`scanDirectory` stores the `Buffer` from `readFileSync`. On Node v22.23.3 in this workspace, `Buffer.poolSize` is 8192. Reads of 1, 8, 64, and 1024 bytes came back as views into that pool: `byteOffset` was not 0, the backing `ArrayBuffer` was 8192 bytes, and `worker_threads.isMarkedAsUntransferable` was true on that slab. A 4096-byte read in the same process happened to be an exact buffer. That cutoff is not a contract. Small files use the pool; the implementation must not guess which ones.

The Node 22 `worker_threads` documentation says a pooled `Buffer` cannot be transferred, and cloning it copies the entire pool. Node marks those slabs with `markAsUntransferable`. A `MessageChannel` post of a 64-byte `readFileSync` view arrived as a `Uint8Array` whose `byteLength` was 64 and whose backing store was still 8192, at a non-zero offset. Transferring that view's `ArrayBuffer` threw `DataCloneError`. Copying those 64 bytes into a fresh `ArrayBuffer` and transferring that copy left the original snapshot readable and delivered a backing store of exactly 64 bytes.

So a structured clone of the scanner views can copy pool bytes that are not part of any selected file, including bytes from other reads in the same process. The worker-visible view length is not the amount of memory delivered. Design A is not the delivery mechanism.

`GuestProcess.postMessage` takes the message and an optional transfer list. The Node and browser adapters pass that list to `Worker.postMessage`. Messages that do not move a buffer pass an empty list.

### A. Structured-clone the scanned views (rejected)

Post the scanner `Buffer`s and let the structured clone algorithm copy them. The parent snapshot stays attached, which is necessary, but the worker receives the pool slab behind each small view. Several files that share one slab still deliver that whole slab, including bytes outside those files. There is no per-file upper bound tighter than the pool, and the extra bytes are not the guest's package. Rejected.

### B. Copy each file into an exact `Uint8Array`, then structured-clone (not chosen)

For each selected file, `new Uint8Array(length)` and `set` the scanner bytes, then post those exact views with no transfer list. The clone copies `byteLength` and nothing beside it. The parent snapshot is untouched. A failed post leaves both the snapshot and the staging copies attached; drop the staging copies.

Cost for one guest whose files sum to `S`: the parent keeps `S`, the staging arrays are another `S`, and the worker clone is a third `S`. The staging arrays can be dropped after `postMessage` returns, so steady state is two copies, with a peak of three. This is correct and does not need a transfer list. It is rejected as the default because the extra clone is unnecessary once the staging buffers are already exact and safe to transfer.

### C. Copy each file into its own `ArrayBuffer`, then transfer those (acceptable, not chosen)

Same exact staging copies as B, then pass those `ArrayBuffer`s in the transfer list. The worker owns them. There is no second copy of the staging bytes. The scanner buffers are not in the list, so they stay usable. A `postMessage` that throws before accepting the list leaves the staging buffers attached; drop them. After a successful post, they are detached on the parent and die with the worker if initialization fails.

This meets the ownership rules. A package may contain 4096 files, which is 4096 transfer-list entries and 4096 small allocations. That is legal and worse than one buffer. Chosen only if a single packed buffer proves harder to index than this study expects. It does not.

### D. Pack one guest's files into one `ArrayBuffer` and transfer it (chosen)

Allocate one `ArrayBuffer` of length `S`, the sum of that guest's verified file lengths, including `module.wasm`. Copy each file in at an offset. Send the bytes by transfer, and send the index by structured clone as an array of records, not as an object keyed by path. Each record is `{ path, offset, length }`. `path` is the exact package-relative string. `offset` and `length` select that file's bytes in the transferred pack.

Those records are not Map entries. `new Map(index)` expects an iterable of `[key, value]` pairs. An array of ordinary records is not that iterable, and constructing the map that way would not key it by `path`. The worker converts first:

```javascript
const resources = new Map(
  index.map(({ path, offset, length }) => [
    path,
    { offset, length }
  ])
);
```

Each key is the exact package-relative path. Each value is `{ offset, length }` into the transferred pack. Lookup is `resources.get(path)`. `__proto__` and `constructor` are legal path components (`PATH_COMPONENT` is `[A-Za-z0-9._-]+`) and stay exact keys. A plain object would treat them as prototype operations, so the index is not stored as an object.

A call finds the exact path in that map. A miss returns `NOT_FOUND`. A hit builds `new Uint8Array(pack, offset, length)` over the transferred pack and copies that view into the guest's current linear memory under the check order above. The host does not allocate a buffer of length `out_cap`.

The worker compiles `module.wasm` from that same pack, using the `module.wasm` record: `new Uint8Array(pack, wasmOffset, wasmLength)`. It does not also post or clone the scanner's `module.wasm` `Buffer`. That second post would clone a pool slab on top of the pack. The artifact bytes inside the pack are the verified bytes.

Parent snapshot buffers are never transferred. After a successful post the pack's `byteLength` on the parent is 0 and the worker holds exactly `S` resource bytes. The index is separate metadata, not part of `S`. `stopGuest` marks the guest dead immediately and keeps that pack charged until `terminate()` succeeds, including while termination is still pending. A failed termination does not release the charge and can be retried; a successful one releases it once. Shutdown hook `2` still runs before disposal, so the pack is alive during guest shutdown.

### Worker-side index validation

Validate the index before accepting the map and before `WebAssembly.Instance`. Do not repair, normalize, case-fold, percent-decode, or reinterpret an entry. A failed check produces no partial map and does not start the guest.

Reject the index when any of these is true:

- It is not an array.
- It contains more than 4096 entries.
- Any path is not a valid exact package path under `cgp.package-path/1`. That is the grammar `validatePackagePaths` applies to one path: absolute, `..`, backslash, empty component, a component outside `[A-Za-z0-9._-]`, more than 16 components, or more than 240 bytes.
- Two entries use the same exact path, or the index paths together fail `validatePackagePaths` on a case-fold collision. That collision is rejected, not merged. Map keys stay exact and are not case-folded. A grammatical guest path in a different case remains `NOT_FOUND` at the call, and that guest path is not passed through `validatePackagePaths` together with the index.
- Any `offset` or `length` is not a non-negative safe integer.
- Any range does not fit in the transferred pack. After the integer check, use subtraction: `length > pack.byteLength || offset > pack.byteLength - length`.
- Two ranges overlap. Ranges that only touch at an edge do not overlap.
- The ranges do not cover the pack exactly. The lengths must sum to `pack.byteLength`, with no gap and no unclaimed trailing byte. With overlap already rejected, that is a partition of `[0, pack.byteLength)`.
- The `module.wasm` record is missing, or the worker would compile any slice other than that record. The parent copies the verified artifact into that range and rejects the index before transfer when the record is missing or its length is not the artifact length. Compilation uses that offset and length and no separately posted artifact.

The parent validates this index before `postMessage`, and before `spawn` when the activation flow can build the pack first, so a bad index is not transferred when that order is available. The worker validates again before instantiation. If the pack was already transferred, terminate the worker and drop the pack with it. The parent snapshot stays readable.

| Design | Parent snapshot | Pool bytes in the worker | Extra bytes beyond the parent | Transfer-list size |
|---|---|---|---|---|
| A. Clone scanner views | Intact | Yes, the whole slab | Unbounded by the file length | None |
| B. Exact copy, then clone | Intact | No | `2S` at peak, `S` after the staging copy is dropped | None |
| C. Exact copy per file, then transfer | Intact | No | `S` | One entry per file |
| D. One pack, then transfer | Intact | No | `S` | One entry |

Asking the parent during the call stays rejected. The import is synchronous, and the host does not call `Atomics.wait`. Embedding the files in the Wasm binary stays rejected. It would change the artifact digest. WASI stays rejected.

### Memory accounting

Four piles, not one. Staging and the worker-owned pack are two roles of a resource pack, not two retained copies of the same guest. A successful transfer detaches the staging buffer on the parent (`byteLength` 0) and that buffer is then the worker-owned pack.

| Pile | What it holds | Bound | Already inside `maxSnapshotBytes`? |
|---|---|---|---|
| Verified parent snapshot | Scanner buffers kept for this activation. JavaScript `openResources` reads these. Wasm-only keeps them only for a guest that imports `resource_read`. | Sum of `packageBytes` for modules this activation retained. That sum is what this activation's `maxSnapshotBytes` already counts. | Yes, as a count. Wasm-only previously dropped the RAM after counting it. Retaining it spends that count. |
| Staging pack | The one parent-owned `ArrayBuffer` of length `S` while a transfer is in flight. At most one pack is staged at a time. | `S`, that guest's file-byte sum. Drop it if it is still parent-owned when delivery fails. | No. It is a second RAM copy of bytes the budget already counted, and only until the transfer is accepted. |
| Worker-owned pack | The transferred `ArrayBuffer` for each resource-reading guest, plus that guest's index. | `S` pack bytes per such guest. The index is not part of `S` or of `packageBytes`. | No. Transfer moves the staging allocation. It does not free the parent snapshot. |
| Guest linear memory | The declared Wasm memory. | `maxMemoryBytes` and the declared maximum, unchanged. Outside the resource-pack bound. | No. |

`S` includes `module.wasm`. There is not a further artifact copy beside the pack. The index is metadata. Its input size is bounded by the existing package limits: 4096 files and 240 bytes per path. JavaScript record objects and the `Map` add engine-dependent overhead. This study does not claim an RSS figure for that overhead.

`maxSnapshotBytes` is a per-project-activation limit. It is not a process-wide memory limit. Concurrent activations each keep their own snapshot and their own worker-pack budget. This study does not add those budgets into one process ceiling.

Inside one activation, pack each retained package at most once, for its own guest. Under that rule the worker-owned sum is at most the retained package snapshot, and that snapshot is at most this activation's `maxSnapshotBytes`. The retained parent snapshot plus every resource pack, counting each pack once whether it is still staged or already transferred, cannot exceed twice the retained package snapshot bytes. A guest that does not import `resource_read` adds no pack. A JavaScript module adds no worker pack. Guest linear memory is not part of that relationship. The twice-the-snapshot figure is not a whole-process upper bound across concurrent activations.

Before `new ArrayBuffer(S)`, if this guest's `S` would make this activation's worker-owned total exceed this activation's `maxSnapshotBytes`, fail closed. Do not allocate, spawn, or post. That check is this activation's snapshot budget. It rejects a second pack of a tree already packed for a guest, and a pack of files that are not that guest's retained snapshot. It says nothing about another activation. Do not raise `maxMemoryBytes`. Do not raise `isolateHeapMb`. Node `resourceLimits` and `isolateHeapMb` are optional and do not cap the transferred package backing store. The browser cannot apply `isolateHeapMb`. A file that does not fit in the guest's current memory is `TOO_SMALL`.

### Allocation and transfer failure

Finish pack construction and index validation before `postMessage`. Prefer both before `spawn` when the activation flow can build the pack first. A malformed index is not transferred in that order. The worker still validates before instantiation.

If `new ArrayBuffer(S)` throws, no pack exists. The verified parent snapshot is untouched and still readable. Do not spawn and do not post. Surface the error. No partial guest starts. Do not reread the content store to reconstruct the snapshot. Existing activation cleanup releases the composition lease only after that shutdown succeeds.

If the pack was built and worker creation or message delivery then fails:

- Refund the existing reservation.
- Terminate any worker that was created.
- Preserve the original parent snapshot. Its buffers are not in the transfer list.
- Drop a staging buffer that is still parent-owned. That is a delivery failure before the implementation accepts the transfer. Do not start the guest.
- If ownership was transferred, the parent buffer is already detached. A later throw does not roll that transfer back and does not mean the parent still holds the pack. Terminate the worker to release it.
- Do not reread the content store to reconstruct the snapshot.
- Do not report the composition lease released until shutdown succeeds. A throw from release stays a shutdown failure.

The same termination rule covers a worker that accepts the pack and then fails in `assertGuestBinary`, instantiation, start-section refusal, or index validation. The pack dies with the worker. The parent snapshot stays readable.

## Permission and policy

Link `resource_read` only when all three are true:

1. The manifest `permissions` array contains `cgp.resource.read`.
2. The active policy `allowCapabilities` contains `cgp.resource.read`.
3. This guest has a resource map from its own verified snapshot.

Data files in the package do not grant the import. A manifest permission without the policy grant is refused. A policy grant without the manifest permission is refused. Both grants with no attached map are refused. That last case is the browser backend today, and it is also a Node session that loads a raw `module.wasm` outside activation.

`loadGuest` computes `allowResource` the same way as `allowLog`, then still omits the map unless it has one. The worker refuses the import when `allowResource !== true`. It also refuses the import when the map is absent or the index is malformed, before `WebAssembly.Instance`. A raw load message that sets `allowResource: true` and attaches no map must not link the function. That is the fail-closed rule. The parent remains the only component that can attach a map, and it attaches only the one package's scanned files.

`validateWasm` checks the manifest side only, as it does for `cgp.log`. Policy is not known when a package is packed. `refuseBinary` checks both grants and the start section. `assertGuestBinary` checks the parent's boolean, the start section, and, once the index is part of the message, the worker refuses to build the function if the index is missing or fails validation.

Expected refusal strings, so the three layers can be tested without scraping a stack:

| Condition | Where | Result |
|---|---|---|
| Import is not `cgp.abi.log` or `cgp.abi.resource_read` | All three | Unauthorized import, before instantiation |
| `resource_read` without manifest permission | Package validation and `refuseBinary` | Not granted |
| `resource_read` without policy grant | `refuseBinary` before spawn | `Capability cgp.resource.read is not granted.` |
| `resource_read` with both grants and no map | Worker, before `Instance` | Not available; do not link |
| `resource_read` with a malformed index | Worker, before `Instance` | Rejected; do not instantiate and do not repair the index |
| `resource_read` and a start section | All three | Refused before instantiation |
| `log` and `resource_read` together, both granted, map present | Worker | Both functions on one `cgp.abi` object |

A module that imports neither function stays valid. Existing `cgp.abi/1` guests stay valid.

## Browser and platforms

Windows and macOS can run this import. It does not use the JavaScript activation directory, so Study 010's refusal of JavaScript on those platforms stays as it is. `activateWasmProject` of a wasm-only lock is the path that must work on Linux, Windows, and macOS. A mixed lock still refuses JavaScript before a lease on Windows and macOS, which means that mixed lock does not start there. The Wasm half is not given a special exception that would also import JavaScript.

The browser worker shares the guest runtime and does not open a filesystem, a file URL, or a store path. With no verified pack on the load message, `resource_read` is refused before instantiation even when the manifest lists `cgp.resource.read` and the browser policy lists it too. The same worker copies from a pack when the parent has already attached one. Project activation still does not do that.

## Lifecycle

`activateProject` and `activateWasmProject` both need the map available to a permitted guest.

- Wasm-only: extend the in-memory wasm snapshot to retain `files` when at least one locked module imports `resource_read`. This is not a new digest and not a catalog change. `packageBytes` is unchanged. Modules that do not import the capability can keep the current wasm-only snapshot shape.
- Mixed: `ProjectModuleSnapshot.files` already exists. Pass that guest's files through. Do not pass the other package's files. JavaScript `openResources` is unchanged and still does not see the Wasm package unless it is that JavaScript module's own tree.
- JavaScript-only: no Wasm import, no worker map, no change to `openResources`.

The package layer may set a structural field on the implementation object that already carries `wasm`. `createCrossBackend` forwards that object. Do not add the map to `RegisterContext`, `LifecycleContext`, or the public `ModuleImplementation` type in the first slice. The isolate reads the field only after `refuseBinary` has accepted the import. If the import is accepted and the field is missing, refuse before spawn returns a loaded guest.

Shutdown hook `2` runs before resource invalidation and before disposal, so the worker pack is still there. Invalidation drops the parent JavaScript views. Disposal terminates the worker and drops the pack. The lease is still held across both. `already: true` stays the existing rule: only after those steps have succeeded. Allocation failure, worker-creation failure, and transfer failure follow the rules in Allocation and transfer failure. The parent snapshot buffers are not in the transfer list. A throw is not proof that a transfer was refused: before accept, drop the parent-owned staging pack; after accept, terminate the worker that owns the pack.

## Memory edge cases

| Case | Required behavior |
|---|---|
| `i32` with the high bit set | Treat as unsigned. Do not reject a pointer merely because the JS value is negative. |
| `path_len` of 0 | `BAD_PATH`. Do not read `path`. |
| `out_cap` of 0 and an empty file | `OK`, write 0 to `written`, do not read `out`. |
| `out_cap` of 0 and a non-empty file | `TOO_SMALL`, write the length, do not read `out`. |
| Output ends on the last memory byte | In range. Copy succeeds when the file fits and `written` does not overlap that range. |
| Output would pass the last byte | `BAD_RANGE` before any write. |
| `out` overlaps `written` on a non-empty copy | `BAD_RANGE` before either write. Adjacent edges are not an overlap. |
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
- The guest reads `module.wasm` from the transferred pack and gets the artifact bytes that were hashed. The scanner's `module.wasm` `Buffer` is not posted again.
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
- Invalid UTF-8, empty path, absolute path, `..`, backslash, a percent-encoded segment, a path longer than 240 bytes, and a path deeper than 16 components return `BAD_PATH` and do not write.
- A grammatical path in a different case returns `NOT_FOUND` and does not write. The lookup is not case-folded.
- A file whose path is `__proto__` or `constructor` is read by exact `Map` key when it is in the package, and is `NOT_FOUND` when it is not. The index is not a plain object. The map is `new Map(index.map(({ path, offset, length }) => [path, { offset, length }]))`, not `new Map` on the record array.
- `out` and `written` that overlap exactly, or partially, on a non-empty `OK` path return `BAD_RANGE` and leave both ranges unchanged.
- The same ranges placed so they only touch at an edge succeed.
- A destination that ends on the last byte of memory succeeds when the file fits, and `written` placed in the last four bytes succeeds when that range does not overlap the destination.
- An out-of-range path pointer or `written` pointer returns `BAD_RANGE` and does not write the other buffer.
- Another package's path is `NOT_FOUND` or `BAD_PATH`. It is never a successful read. The guest has no argument for a package digest.

Lifecycle and budgets:

- Snapshot budget failure throws before any guest starts and releases the lease.
- One bad package prevents an earlier guest from starting.
- An unrelated unpinned object can be collected while the lease is held.
- The leased object's resource bytes do not change if the store object is rewritten after the snapshot.
- A read from shutdown hook `2` succeeds.
- After backend disposal, the worker is gone and a further read is impossible.
- Worker `spawn` failure, `postMessage` failure, instantiation failure, and disposal failure leave the parent snapshot bytes readable at their original lengths. They do not report the lease released until shutdown succeeds.
- After a successful delivery the worker's pack `byteLength` equals `S`, every index length matches the verified file, and no backing store larger than its view is part of the payload. Bytes from a `Buffer` pool slab are not delivered. The worker compiles `module.wasm` from that pack.
- The pack contains only that guest's package. Another package's path is absent.
- A worker that fails after the transfer is terminated, and that termination drops the pack. The parent snapshot is still readable. A throw after the transfer was accepted is not treated as a transfer that never happened.
- `new ArrayBuffer(S)` throwing does not spawn, does not post, and leaves the verified parent snapshot readable. No partial guest starts. Lease cleanup stays the existing activation path.
- A malformed index does not instantiate and is not repaired. Cover at least: a non-array; more than 4096 entries; a path that fails package-path grammar; a duplicate exact path; a case-fold collision inside the index; an offset or length that is not a non-negative safe integer; a range that fails `length > pack.byteLength || offset > pack.byteLength - length`; overlapping ranges; lengths that do not sum to `pack.byteLength`; a gap or unclaimed trailing bytes; a missing `module.wasm` record. If the pack was already transferred, termination drops it. The parent snapshot stays readable.
- Another activation's snapshot and packs are not charged against this activation's `maxSnapshotBytes`.
- JavaScript `openResources` behavior from Study 011 is unchanged.
- Windows and macOS still refuse JavaScript activation before a lease. Wasm-only activation, including a permitted resource read, still runs there.
- The host does not call `memory.grow` for a read. A guest that grows and then reads sees the new memory, not a detached view.

## Implementation phases

1. **This study.** No runtime change.
2. **Allowlist agreement.** Teach `inspectWasm` about the start section. Teach `validateWasm`, `refuseBinary`, and `assertGuestBinary` the new names and the start refusal. Build one `cgp.abi` object. Existing guests stay green. No successful read yet.
3. **Pack and status codes.** Retain wasm-only files in memory when the import is present. Pack that one package into one exact `ArrayBuffer`. Validate the `{ path, offset, length }` index, then transfer the pack. On the worker, build the map with `new Map(index.map(({ path, offset, length }) => [path, { offset, length }]))`, validate again, and do not instantiate on failure. Compile `module.wasm` from that pack only. Implement the check order above, including overlap. Do not post scanner `Buffer`s and do not transfer parent snapshot buffers. Add the optional transfer list to `GuestProcess.postMessage`.
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
- Whether wasm-only snapshots should always retain `files`, or only when `resource_read` is imported. Recommendation: only when the import is present, so guests that do not read pay today's memory cost. The scan still has to see the import list, which `validateWasm` already does. `isolateHeapMb` does not grow to fit the pack, and it does not cap the transferred package backing store.
