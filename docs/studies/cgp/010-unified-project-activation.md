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

The snapshot copies artifact bytes into memory and drops its reader marker. It does not keep a store path. JavaScript is later imported from those owned bytes written to a private temporary file. The lockfile has no path, and the store path is not the import URL.

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

The lease covers every locked package, of either runtime. It is acquired before the snapshot and released only after Foundations shutdown, Wasm backend disposal when a Wasm backend exists, and removal of the owned JavaScript copies. It does not hold a reader marker, so unrelated objects can still be collected.

Shutdown is idempotent after every cleanup step has succeeded (`already: true`). Foundations shutdown, Wasm disposal, source-directory removal, and lease release are each marked done only after that step returns. The source path is kept until removal returns, so a failed `rm` is not treated as a finished step on the next call.

Removal walks the directory file descriptor and does not follow symlinks. A symlink entry is unlinked and its target is left in place. A directory whose owner mode lacks write or execute is refused, including when the process is root, so `CAP_DAC_OVERRIDE` cannot hide the failure. A later shutdown retries only the unfinished steps. If lease release throws, the error is that failure. The call does not report the lease released.

Trusted JavaScript can still read its temporary module URL, change permissions, replace the directory, or copy bytes out. This cleanup does not contain that code. Top-level side effects are not rolled back.

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

Opt-in refusal, verification before import, closed-policy refusal, import and initialization cleanup, mixed cross-backend activation, live retention, Wasm budget cleanup, lock rejection, and a visible lease-release retry are covered from `src/packages/project-activation.test.ts`. That file also covers a source directory whose mode blocks removal, a symlink swapped in for that directory, repeated shutdown while cleanup is still failing, and a lease release that succeeds while source cleanup is still failing. Existing Wasm activation tests still cover `activateWasmProject`. Claim ownership is covered from `src/packages/store-retention.test.ts`.
