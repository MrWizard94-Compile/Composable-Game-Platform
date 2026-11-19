# CGP Study 010 — Unified project activation

**Implementation date:** 2026-11-18  
**Implementation baseline:** `main` at `3cc536c` (Study 009 composition leases)  
**Decision status:** Implemented Node activation for JavaScript ESM, Wasm Core, and mixed project locks. No package, lock, or lifecycle schema change. No new execution backend.

## Purpose

`activateWasmProject` could run a verified Wasm-only lock. Stored JavaScript and mixed locks could not. This study adds `activateProject` on the existing Foundations lifecycle, `wasm-isolate`, the cross backend, the content store, and the Study 009 composition lease.

Package management stays outside Foundations. The host still does not compile TypeScript. The format-v1 JavaScript artifact remains `module.mjs`.

## Verification before execution

`activateProject` does all of the following before it imports JavaScript or starts a guest:

1. Validate the project lock and its profile digest, order, and exact versions.
2. Resolve every locked identity in the local catalog. A missing or differing identity fails the project.
3. Reject a runtime other than `wasm-core` or `javascript-esm`.
4. Acquire one composition lease for every locked digest. Each object must be ready, and its package tree must verify, or the lease is not written.
5. Snapshot every package under an explicit aggregate byte budget. One corrupt package fails the snapshot. No earlier package is imported.

`activateWasmProject` still refuses JavaScript with `Wasm-only project snapshot refuses ... javascript-esm` before that lease. It then uses the existing Wasm-only snapshot.

The snapshot copies every regular file that contributed to the package-tree digest into memory and drops its reader marker. It does not keep a store path. `packageBytes` already counts those files, and the retained buffers are the scanned buffers, not a second copy of the tree. JavaScript is later imported from the owned artifact bytes written to a private temporary file. The lockfile has no path, and the store path is not the import URL. Non-artifact files are not written into that directory. An opted-in JavaScript module can read them only through the package resource view in Study 011.

## Trust

JavaScript is trusted in-process code. It can use the Node process and that process's filesystem, network, and operating-system access. It is not sandboxed. The Wasm import allowlist does not apply to it.

Import requires `javascript: "trusted-in-process"`. Omitting that opt-in throws before a lease and before any import, even if the policy would otherwise allow the in-process grants.

A closed policy does not import JavaScript. Foundations reports `trust.grants` or `trust.limits` and the activation releases the lease. Default policy is:

| Packages | Default policy | Backend |
|---|---|---|
| Wasm only | closed | `wasm-isolate` |
| JavaScript only, after opt-in | `IN_PROCESS_POLICY` | `in-process` |
| Both, after opt-in | `CROSS_POLICY` | existing `cross` backend |

A mixed project does not become one sandbox. JavaScript hooks stay in-process. Wasm guests stay on `wasm-isolate`, with the existing memory, binary, hook, and ABI limits. `limitsEnforced` means the isolate enforces those limits. It does not limit the JavaScript half.

Importing trusted JavaScript runs its top-level code. That can happen before `initialize`, and those side effects are not rolled back if a later import or initialization fails.

## Lease and shutdown

The lease covers every locked package, of either runtime. It is acquired before the snapshot and released only after Foundations shutdown, invalidation of package resource views, Wasm backend disposal when a Wasm backend exists, and removal of the owned JavaScript copies. It does not hold a reader marker, so unrelated objects can still be collected.

Shutdown is idempotent after every cleanup step has succeeded (`already: true`). Foundations shutdown, resource invalidation, Wasm disposal, source-directory removal, and lease release are each marked done only after that step returns. The source path is kept until removal returns, so a failed removal is not treated as a finished step on the next call. Resource views stay open through Foundations shutdown hooks. They are invalidated only after that shutdown settles. A failed invalidation is retried and is not described as a released lease.

## Cleanup platforms

| Platform | JavaScript import | Removal | What CI runs |
|---|---|---|---|
| Linux, when `O_NOFOLLOW`, `O_DIRECTORY`, and `/proc/self/fd` exist | After the usual opt-in | Directory file descriptor. No symlink is followed. Owner write and execute are required before a directory is walked, including when the process is root. | Full foundations workflow on `ubuntu-latest` |
| Windows | After the usual opt-in | `lstat` walk. Symlink entries are removed without opening the target. A root path replaced by a symlink is refused. POSIX owner bits are not consulted. A read-only file bit is cleared before unlink because Windows otherwise rejects the delete. | `src/packages/project-activation.test.ts` and `src/packages/package-resources.test.ts` on `windows-latest` |
| macOS | After the usual opt-in | The same `lstat` walk as Windows, plus the POSIX owner-mode check | Those same two files on `macos-latest` |
| Anything else | Refused before a composition lease and before import, when JavaScript would actually be imported | Not attempted | Not claimed |

The Windows and macOS walk re-checks the directory after `readdir` and discards the names if the inode changed. It does not close the race the Linux descriptor walk closes: a swap that returns to the original inode during `readdir` can still be observed. That limitation is why those platforms are not described as equivalent to Linux. A closed policy does not import JavaScript, so it does not need this cleanup and is not refused for lack of it. Wasm-only activation does not create the directory.

A symlink entry is unlinked, or removed with a non-recursive `rmdir` when the platform requires that for a directory link. Its target is left in place. A later shutdown retries only the unfinished steps. If lease release throws, the error is that failure. The call does not report the lease released.

Trusted JavaScript can still read its temporary module URL, change permissions, replace the directory, or copy bytes out. This cleanup does not contain that code. Top-level side effects are not rolled back. Permission failures that Windows cannot represent as POSIX modes are injected in tests. Those probes are not a host API.

A failed activation releases what it acquired. An import failure releases the lease before a backend is left running. An initialization or Wasm budget failure returns the Foundations result when Foundations does, then shuts the activation down. If that cleanup also fails, both failures are reported.

## What this does not do

- No browser activation of stored packages. The console still composes bundled proof packages.
- No hot reload and no active-generation publication.
- No new runtime backend, remote registry, or dependency solver.
- No TypeScript compilation inside CGP.
- No claim that JavaScript is sandboxed.
- No path-backed loader. Deleting the store object after import does not rewind code that already ran, but the lease still blocks GC while the activation is live.
- No automatic stale-reader or stale-lease reclamation.

## Deletion claims

Separate from activation: `store:gc-reconcile --apply` no longer drops token-owned `deleting` claims. That command is not stale-owner recovery and does not consult pid or age. The holder releases a claim with its token. An operator revokes one named claim with `--cancel-claim --digest`. That cancellation is administrative. It does not sweep other claims and it does not delete bytes.

## Conformance coverage

Opt-in refusal, verification before import, closed-policy refusal, import and initialization cleanup, mixed cross-backend activation, live retention, Wasm budget cleanup, lock rejection, and a visible lease-release retry are covered from `src/packages/project-activation.test.ts`. That file also covers a source directory whose mode blocks removal on POSIX, a symlink swapped in for that directory, symlink entries whose targets stay in place, repeated shutdown while cleanup is still failing, a lease release that succeeds while source cleanup is still failing, injected removal and disposal failures that do not depend on POSIX modes, concurrent shutdown, and a platform that refuses JavaScript before a lease. Package resource reads are covered from `src/packages/package-resources.test.ts`. Existing Wasm activation tests still cover `activateWasmProject`. Claim ownership is covered from `src/packages/store-retention.test.ts`.
