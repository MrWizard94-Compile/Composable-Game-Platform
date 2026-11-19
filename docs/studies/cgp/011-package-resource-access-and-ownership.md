# CGP Study 011 — Package Resource Access and Ownership

**Research date:** 2026-11-18  
**Research baseline:** `main` at `89225fb` (Study 010 unified activation)  
**Implementation date:** 2026-11-18  
**Decision status:** Design A is implemented for opted-in JavaScript where Linux file-descriptor cleanup can pin the activation directory. Windows and macOS refuse that import before a lease. No package, lock, or catalog schema change. No new digest profile. No new execution backend. Wasm guests still have no resource import. Browser transport is not implemented.

## Implementation status

`snapshotReleasePackageDirectory` and `ProjectModuleSnapshot` keep every regular file from the verifying scan. The buffers are the scanned buffers. `artifactBytes` is the artifact entry in that set. `packageBytes` is unchanged and already includes every file, so the aggregate `maxSnapshotBytes` budget is not a second copy of the tree. The Wasm-only snapshot still returns the artifact and the byte count. It does not grow a file map, and a Wasm guest is not handed one.

After a JavaScript module is imported from its snapshotted `module.mjs`, and before `compose`, activation calls optional `openResources(view)` if that function exists on the implementation. Foundations `RegisterContext` and `LifecycleContext` are unchanged. `ModuleImplementation` in Foundations was not extended; the package layer checks the method structurally. The view exposes `packageTreeDigest`, `read(path)`, and `list()`. `read` accepts only an exact `cgp.package-path/1` string, returns a new `Uint8Array`, and fails for a missing key. It does not decode, normalize, or case-fold. `list` returns the paths that were hashed. The object has no store path, host directory, or file URL. A module cannot name another package.

The view stays open through Foundations shutdown hooks. Invalidation runs after that shutdown settles and before Wasm disposal, source removal, and lease release. A failed invalidation stays unfinished. A later shutdown retries it. The lease is not reported released when release throws. `already: true` is returned only after invalidation, source removal, backend disposal, and lease release have all succeeded.

### Deviations from the research recommendation

- Windows and macOS do not host the JavaScript view. Node's public filesystem API cannot pin a directory against a symlink swap there: it does not expose `openat`, `fdopendir` of an existing descriptor, or a Windows handle opened with `FILE_FLAG_OPEN_REPARSE_POINT`, and macOS `/dev/fd` is not that walk. Repeating `lstat` does not close the race, so that walk was removed. `activateProject` throws before a composition lease, before import, before top-level module code, and before `openResources`. The error says no lease was acquired. No activation directory is created. A closed policy and Wasm-only activation still run. The resource map itself has no directory inode to follow on any platform. The view API is unchanged and is reached only where the Linux file-descriptor cleanup is available.
- `read` copies with `new Uint8Array` and `set`. A `Buffer.slice` would alias the retained bytes, so that was not used.
- Wasm-only activation does not retain the non-artifact map. Mixed and JavaScript project activation does, including for a Wasm package in that project, but only a JavaScript module is offered the view.
- Test probes can fail removal, backend disposal, and resource invalidation without POSIX permission bits. They are not a caller API.

Designs B and C stay rejected. The exclusions below the research text still apply to everything this slice did not build.

## Problem and architectural context

A format-v1 package is a tree of regular files. `cgp.package-tree/1` hashes every file: the manifest, `cgp-package.json`, the executable artifact, and anything else the packer copied (`README.md`, `LICENSE`, `NOTICE`, `docs/`, `assets/`, `data/`, and paths passed to `--include`). The artifact digest covers only `module.mjs` or `module.wasm`. Changing a data file changes the package-tree digest and therefore the lock, and it does not change the artifact digest.

The scanner in `src/packages/package-directory.ts` already reads those bytes under the path rules in `validatePackagePaths`. It refuses symlinks, special files, `..`, backslashes, case collisions, and the documented size limits (4,096 files, 64 MiB per file, 128 MiB total, 240 UTF-8 bytes per path, 16 components). `snapshotReleasePackageDirectory` then keeps the artifact bytes and a total byte count. `ProjectModuleSnapshot` in `src/packages/project-lock.ts` has the same shape. The other file bytes are discarded after the digest check.

`activateProject` imports JavaScript from a private copy of the artifact bytes and passes Wasm bytes to `wasm-isolate`. Neither runtime receives the rest of the tree. A module that wants an asset today has no supported lookup. Giving it the store object directory would hand it an arbitrary filesystem path, reopen a verify-then-use gap, and couple reads to the store for the life of the composition.

Package management stays outside Foundations. Foundations `RegisterContext` and `LifecycleContext` carry `moduleId`, `contribute`, `keep`, `ownedSlot`, and `kept`. They do not carry package bytes or paths. The Wasm allowlist is still only `cgp.abi.log`, and only when the manifest declares `cgp.log`. JavaScript remains trusted in-process code. A resource API does not sandbox it.

The activation directory that holds the temporary `module.mjs` is not a resource filesystem. Its cleanup must not follow symlinks, and a failed removal must stay retryable. That cleanup does not contain trusted JavaScript. A module can read `import.meta.url`, chmod the directory, or copy bytes out before shutdown. Those side effects are not rolled back.

## Designs

### A. Activation-owned byte snapshot and an opaque per-module handle

During the existing verifying scan, keep every regular file that contributed to the package-tree digest, not only the artifact. The activation owns that map. A module receives an opaque handle closed over its own map.

A read takes a `cgp.package-path/1` relative path and returns a copy of those bytes. The handle is not a string, not a URL, and not a store path. Listing returns the relative paths already in the map. There is no `join` against a directory.

JavaScript would see the handle from the package layer, before `compose`, by an optional `openResources` call on the implementation. Foundations context types stay unchanged. Wasm would not see the handle. A later slice can add one explicit `cgp.abi` import that copies bytes into guest memory, gated the same way `cgp.abi.log` is gated. That is an allowlist addition, not a new backend, and it is not part of this study's implementation.

### B. Lease-protected reads of the immutable store object

The composition lease already stops GC from deleting the locked objects. The host would keep the object directory private and, on each read, open a relative path inside it under a short-lived reader marker. The module still receives only an opaque handle.

This avoids a second copy of large assets. It reopens the problems Study 010 closed. The store file is not the byte string that was hashed unless every read re-verifies the tree. Read-only mode is not a security boundary against the store owner. A reader held across a guest call stalls writers. A path bug, or trusted JavaScript inspecting the handle, leaks a store location. The browser cannot open that directory later. The design has to grow a copy step anyway for the browser, so the Node path would not be the long-term one.

### C. A new resource identity beside the package tree

Declare assets as their own content-addressed objects, or add a manifest `resources` list whose digest is a new profile. Modules ask for `sha256:` identities. Packages share bytes by hash.

This is a real model for a registry. It is the wrong first step here. `cgp.package-tree/1` already names every file by path plus content hash. A second identity changes the package contract, the lock, and the catalog without giving the browser or the Wasm guest anything they cannot get from the existing tree. A manifest allowlist of paths inside the current tree is a useful later filter. It should not be a new digest profile.

## Comparison

| Question | A. Copied snapshot | B. Store reads | C. New resource identity |
|---|---|---|---|
| Paths visible to the module | None. Lookup is an exact map key. | None if the host is careful. The host still holds a path. | None. Lookup is a digest. |
| Same bytes that were verified | Yes. The scan that hashed the tree keeps the bytes. | Only if every read re-hashes. | Only after a new digest is defined and verified. |
| Package-tree contract | Unchanged. | Unchanged. | Changed or duplicated. |
| Store reader during the composition | Not held. The existing lease remains the GC root. | A per-read reader, or a worse long-lived one. | Not required for an in-memory object. |
| GC of unrelated objects | Still allowed. The lease does not cover them. | A stuck reader blocks writers, not just the leased objects. | Same as A if bytes are copied. |
| Wasm isolation | Unchanged until an explicit ABI import exists. | A store path must never be imported. Easy to get wrong. | Same ABI problem as A. |
| JavaScript trust | Still trusted in-process. The API is not a sandbox. | Same, and the module may find the store itself. | Same. |
| Browser later | Ship the same records. No local paths. | Does not transfer. | Transfers only after the new identity exists. |
| Memory | Bounded by the snapshot budget already enforced. | Lower. | Similar to A, plus a schema migration. |

## Security and concurrency

Path traversal, encoding, and case tricks are refused by not joining paths. The key is the exact relative string that `validatePackagePaths` already accepted. `%2e%2e`, backslashes, `..`, empty components, and a second spelling of the same folded path never enter the map. A lookup that is not an exact key fails. It is not decoded and not normalized again.

Symlinks and special files never enter the map. The scanner already rejects them. The in-memory snapshot has no directory inode to follow.

A handle closes over one package-tree digest. It has no argument for another digest, another module id, or a store path. Cross-package reads need a future explicit contract. They are not a fallback when a path is missing.

JavaScript remains trusted in-process. It can ignore the handle and use `node:fs`. The Wasm import allowlist does not apply to it. Mixed activation is still not one sandbox. Publishing this API must not be described as containing JavaScript.

Wasm stays on `wasm-isolate`. No WASI preview, no filesystem import, and no path string crosses the ABI. A future resource import copies a bounded slice into guest memory and is refused unless the manifest declares it. Guest memory limits still apply. `limitsEnforced` still does not mean the JavaScript half is limited.

Budgets stay the existing ones. The activation `maxSnapshotBytes` cap is the aggregate. Per-file and per-tree ceilings stay the package limits. A read returns a copy so the caller cannot rewrite the snapshot. Trusted JavaScript can copy the result as many times as it wants. That is not a sandbox failure. A Wasm copy that does not fit in the guest memory allocation fails the call and does not grow the host snapshot.

Concurrent GC does not need a composition-lifetime reader. The snapshot is taken under the existing reader, the reader is dropped, and the composition lease remains the retention root for every locked digest. Unrelated unpinned objects can still be collected. Resource reads do not take the writer lock and do not wait on it. A store mutation after the snapshot does not change the handle. If the leased object is later replaced on disk, the running module still has the verified bytes.

The temporary JavaScript directory is a loader detail. It is not the resource map. Linux cleanup opens it with `O_NOFOLLOW` and `O_DIRECTORY`, walks `/proc/self/fd`, unlinks a symlink entry without following it, and refuses a directory whose owner mode lacks write or execute, including when the process is root. Windows and macOS never create that directory: JavaScript activation is refused before a lease. Trusted code on Linux can still chmod the directory, replace it, or retain copies. Cleanup is not a confinement mechanism for trusted in-process JavaScript.

## Resource identity and versioning

A resource is the pair `(packageTreeDigest, relativePath)` inside one verified `cgp.package-tree/1` snapshot.

- The path is the exact `cgp.package-path/1` string.
- The bytes are the bytes hashed into that tree. The inner SHA-256 already computed for the tree is the file's content id. It does not need a new profile in the first slice.
- The artifact digest stays the digest of the executable only.
- Replacing an asset changes the package-tree digest. Projects that want the new asset change the lock. There is no floating resource version.
- Catalog coordinates stay `moduleId@version` to one package-tree digest. This study does not add a resource coordinate.
- Two packages that contain equal bytes still have two handles. Equality of content is not permission to read the other package.

## Lifetime and cleanup

1. The map is built inside the verifying snapshot, before any JavaScript import and before any guest starts. One bad package still fails the whole activation, and no earlier module is imported.
2. The composition lease is acquired before that snapshot, as it is today, and covers every locked digest.
3. The reader marker ends when the snapshot exists. It is not held for the composition.
4. Handles stay valid through Foundations hooks, including shutdown hooks, so a module can read while it is stopping.
5. After Foundations shutdown, the activation drops the maps, then removes owned JavaScript copies, then releases the lease. A drop is complete only after the handles have been invalidated. A later shutdown retries a step that threw. It does not report the lease released if release threw, and it does not report `already: true` while a map, a source directory, or the lease is still owed.
6. A failed activation drops whatever it acquired before returning or throwing. If that cleanup throws, the original failure and the cleanup failure are both visible.
7. Bytes a module already copied out are ordinary JavaScript or guest memory. They are not revoked. Top-level JavaScript side effects are still not rolled back.

## Failure scenarios

- Unknown path, absolute path, `..`, backslash, or a folded collision: the read fails. No other file is returned.
- Path present in the package but not in this handle's map: fail. Do not search the store.
- Handle used after shutdown: fail. Do not recreate the map from disk.
- Snapshot over the aggregate budget: activation throws before import, and the lease is released. Existing behavior.
- Digest mismatch or a missing file during the scan: activation fails before import. Existing behavior.
- Symlink or special file in the package directory: the scan fails. Existing behavior.
- Module asks for another package's path: there is no such argument. The call cannot name that digest.
- GC runs during the session: leased objects stay. Unrelated unpinned objects may go. The handle's bytes do not change.
- Cleanup of the JavaScript directory fails, or lease release fails: shutdown rejects. A retry finishes only the unfinished step. Resource maps follow that same rule once they exist.
- Trusted JavaScript deletes or chmods its loader directory: that is a loader-cleanup failure, not a resource-map failure, and it does not prove the module was contained.

## Recommended design

Use design A.

Keep the verified file bytes with the activation snapshot. Address them only as `(packageTreeDigest, relativePath)`. Give each module an opaque handle to its own map. Do not pass store paths into Foundations, into JavaScript, or into a Wasm guest. Do not hold a store reader for the composition. Keep the Study 009 lease as the GC root. Do not add a digest profile. Do not add a backend.

The first implementation slice should be JavaScript-only and package-layer-only: an optional `openResources` view, exact-key reads, copies, shutdown invalidation, and tests. Wasm stays on the current allowlist until a separate ABI slice. Browser transfer of those same records is a later transport, not a filesystem bridge.

Design B is rejected as the default because it brings back path ownership and a verify-then-use gap. Design C is rejected until a registry actually needs shared blobs. A path allowlist inside design A can wait until a module needs to hide files that are still part of the tree digest.

## Staged implementation proposal

1. **Research record.** The comparison above is unchanged. Design A is the chosen model.
2. **JavaScript slice.** Implemented. The project snapshot retains the scanned file buffers. Opted-in JavaScript receives an opaque per-package view through `openResources`. Reads are exact keys and return copies. Shutdown invalidates the view after Foundations hooks. No Foundations context change. No Wasm import. No browser. No cross-package read.
3. **Wasm ABI slice.** One new `cgp.abi` import, manifest-gated like `cgp.log`, copying into guest memory under the existing memory limit. Unauthorized imports still fail before the guest runs.
4. **Browser slice.** Send the same verified records over a bounded channel. Do not send local paths. Do not activate from the console until that transport exists.
5. **Not scheduled.** Cross-package resource exports, hot reload, a remote registry, a dependency solver, or a new digest profile.

## Conformance and failure-injection tests

The JavaScript slice is covered by `src/packages/package-resources.test.ts`:

- A data file read after activation equals the bytes that were hashed into the package tree.
- Changing that data file changes the package-tree digest and the project lock, not only the artifact digest.
- `..`, an absolute path, a backslash, a percent-encoded dot segment, and a differently cased path are rejected.
- The view's public values contain no store path and no host directory.
- Package A cannot read a file that exists only in package B.
- A missing key fails and does not fall open onto the store.
- The snapshot budget still rejects the project before any import and releases the lease.
- An unrelated unpinned object can be collected while the lease is held. The locked object cannot. The read result is unchanged.
- A read works during a shutdown hook. After a successful shutdown, a read fails. A second shutdown is `already: true`.
- If invalidating the view throws, shutdown rejects, the lease is not described as released, and a retry can finish.
- A closed policy still does not import JavaScript, so the view is never handed out.
- A Wasm package in the same project still has no filesystem import and no resource import.
- The loader-directory tests from Study 010 still pass. Resource reads do not use that directory.

Slice 3 adds: a guest without the manifest permission is refused at validation; a permitted read copies the file; an oversized copy fails inside the guest limit; a symlink package is still refused before instantiation.

## Explicit non-goals

- Browser loading of stored packages.
- Hot reload or active-generation publication.
- A new execution backend, remote registry, or dependency solver.
- Changing `cgp.package-tree/1`, the lock schema, or the catalog schema.
- Holding a store reader for the composition lifetime.
- Sandboxing JavaScript, or claiming the Wasm allowlist covers it.
- Letting a module read another package's files without a future explicit contract.
- WASI, host filesystem imports, or path strings inside a guest.
- Using activation-directory cleanup as a confinement mechanism.
