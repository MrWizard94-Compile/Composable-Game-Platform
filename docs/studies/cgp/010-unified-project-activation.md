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

JavaScript activation is admitted only where removal cannot be retargeted onto another directory after the check. Node 22's public filesystem API can do that on Linux. It cannot do it on Windows or macOS.

Linux opens with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` and walks `/proc/self/fd`. A child observed as a symlink is unlinked and not opened. If that child is replaced by a symlink after `lstat` and before `open`, `open` returns `ENOTDIR` or `ELOOP` and only the link is removed. The root path is checked against the opened device and inode before and after the walk. A symlink there is refused and not removed, so a swap cannot make `rmdir` follow it. Owner write and execute are required before a directory is walked, including when the process is root. `chmod 0555` does not stop a privileged `rm`, so the mode check is what blocks it.

Windows has no `O_NOFOLLOW`, `O_DIRECTORY`, or `/proc`. macOS has `O_NOFOLLOW` and `O_DIRECTORY`, but `/dev/fd/N/child` is not a reliable `openat`, and Node cannot `fdopendir` an existing descriptor. Repeating `lstat` does not close the swap. A native addon was not added. The previous non-following `lstat` walk was removed so it cannot be mistaken for the Linux guarantee.

| Platform | JavaScript import | Removal | What CI runs |
|---|---|---|---|
| Linux, when `O_NOFOLLOW`, `O_DIRECTORY`, and `/proc/self/fd` exist | After the usual opt-in, and only after that cleanup is available | Directory file descriptor, as above | Full foundations workflow on `ubuntu-latest` |
| Windows | Refused before a composition lease, before import, before top-level module code, and before a resource view. The error says the platform cannot pin the directory against a symlink swap and that no lease was acquired. No activation directory is created. | Not attempted | `src/packages/project-activation.test.ts` and `src/packages/package-resources.test.ts` on `windows-latest`, asserting that refusal. Closed policy and Wasm-only activation still run. |
| macOS | The same refusal as Windows | Not attempted | Those same two files on `macos-latest`, asserting that refusal |
| Anything else | The same refusal | Not attempted | Not claimed |

A closed policy does not import JavaScript, so it does not need this cleanup and is not refused for lack of it. Wasm-only activation does not create the directory and is not refused. When JavaScript would be imported and cleanup is unavailable, the throw happens before `acquireCompositionLease`. A Wasm backend created only for that preflight is disposed first. Nothing that cannot be cleaned up is kept.

A symlink entry inside an owned Linux directory is unlinked. Its target is left in place. A later shutdown retries only the unfinished steps. If lease release throws, the error is that failure. The call does not report the lease released.

Trusted JavaScript can still read its temporary module URL, change permissions, replace the directory, or copy bytes out. This cleanup does not contain that code. Top-level side effects are not rolled back. Test probes can swap a directory after validation and can fail a cleanup step. Those probes are not a host API.

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

Opt-in refusal, verification before import, closed-policy refusal, import and initialization cleanup, mixed cross-backend activation, live retention, Wasm budget cleanup, lock rejection, and a visible lease-release retry are covered from `src/packages/project-activation.test.ts`. On Linux that file also covers a source directory whose mode blocks removal, a symlink swapped in for the activation directory before shutdown, symlink entries whose targets stay in place, and three deterministic swaps injected after validation: the root, a nested directory, and an ancestor of a pinned child. External sentinel files stay in place. A failed removal stays retryable and does not report `already: true`. Injected removal and disposal failures, concurrent shutdown, and a probe that forces cleanup off are covered there too. Where the host cannot pin a directory, the same file asserts that opted-in JavaScript throws before a lease, writes no top-level marker, does not call `openResources`, still accepts a closed policy, and still activates Wasm-only. Package resource reads, ownership, and invalidation are covered from `src/packages/package-resources.test.ts` on Linux. On Windows and macOS those two files run in CI to prove the refusal and the paths that do not import JavaScript, not to claim a successful JavaScript activation. Existing Wasm activation tests still cover `activateWasmProject`. Claim ownership is covered from `src/packages/store-retention.test.ts`.
