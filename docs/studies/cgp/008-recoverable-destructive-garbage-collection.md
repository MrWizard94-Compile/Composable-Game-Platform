# CGP Study 008 — Recoverable destructive garbage collection

**Implementation date:** 2026-11-18  
**Implementation baseline:** `main` after the ADR 0020 integration (`ad49569`) and Study 007's retention preview  
**Decision status:** Implemented package-store deletion slice. No package or lock schema changes. Lifecycle sidecar migrates from `cgp.local-store-lifecycle/1` to `cgp.local-store-lifecycle/2`.

## Purpose

Study 007 can pin objects, preview collection, and reserve a deletion claim. It does not remove bytes. This study adds a crash-recoverable deletion path on that same lifecycle. It does not add a runtime, a registry, or a new retention root.

## Lifecycle

In-memory and newly written sidecars use `cgp.local-store-lifecycle/2`. A v1 file is still accepted. Reads migrate it in memory. Preview does not rewrite it. The next writer persists v2. Missing sidecars still synthesize a local pin for every catalog object and are not persisted by preview.

| State | Owner | Preconditions | Persisted record | Bytes | Recovery |
|---|---|---|---|---|---|
| `ready` | registration, pin, reconcile, claim release | object is not in an in-progress deletion | digest, timestamps | canonical directory | none |
| `deleting` | `claimPackageObjectDeletion` | writer gate, no pins, digest verified, grace elapsed | claim token, pid, time | canonical directory | not a deletion; reconcile or apply-with-token |
| `intent` | apply, under the same writer gate | fresh pin, grace, and digest recheck; claim token | claim plus deletion intent (`writerToken`) | canonical directory | move to quarantine, or fail closed |
| `quarantined` | deletion advance | intent exists; tombstone is the only copy | intent plus tombstone name | `.cgp-store-tombstones/<hex>/` | start removal, or fail closed |
| `removing` | deletion advance | tombstone recorded before the first unlink | intent, tombstone, `removal.startedAt` | partial or full tombstone | finish regular-file removal, or fail closed |
| `deleted` | deletion advance | tombstone bytes are gone | deletion record, no claim | neither location | idempotent; a leftover matching tombstone may be finished; a canonical object is not deleted |
| `ambiguous` | recovery | both copies, neither copy, a symlink, or another unsafe shape | reason and time | untouched | report again; do not delete |

Every transition above `ready` is written to the sidecar before the next destructive step. An in-memory flag is not the source of truth. `ready` readers and new pins are refused for every other state. `deleted` may be registered again, which republishes the bytes and returns the object to `ready`. In-progress states cannot be registered over.

Catalog rows are not retention roots and are not removed when bytes are deleted. `resolveLocalPackage` and `verifyLocalStore` then report the release as unavailable until it is registered again.

## Deletion procedure

Apply and claim-apply hold the existing exclusive writer lock and wait for readers to drain. They do not accept a preview document as authorization.

1. Recheck local pins, project pins, composition leases, grace, and the package-tree digest. Measure the tree without following symlinks.
2. Persist `intent` with the claim token and the current writer-lock token.
3. Make the object directory writable and `rename` it into `.cgp-store-tombstones/<hex>` on the same store filesystem. The directory itself must be writable or ext4 refuses the rename. Children are not retargeted.
4. Persist `quarantined`, then `removing`.
5. Thaw and unlink only regular files. Refuse a symlink or special entry without removing it or its target.
6. Persist `deleted` only after the tombstone directory is gone.

`store:gc-preview --dry-run` remains read-only. Registration, verification, and project-lock commands do not delete content.

## Crash recovery

`recoverInterruptedStoreDeletions` is idempotent.

- No intent and the canonical directory still present: nothing is deleted.
- `intent` plus only the canonical directory: the move is performed, then removal finishes.
- `intent` plus only the tombstone: removal finishes. The object is not treated as already deleted.
- `removing` plus a partial tombstone: removal finishes.
- `removing` plus neither copy: the deletion is finalized.
- Both copies, a symlink, a special file, or a canonical directory left beside a `deleted` record: state becomes or stays `ambiguous` and bytes stay where they are.

A writer lock is adopted only when both of these are true: its token equals the `writerToken` stored in an `intent`, `quarantined`, or `removing` record, and the lock's pid is not alive. Unknown liveness fails closed. A dead pid with a non-matching token does not authorize removing the lock. Idle claims and unrelated locks are not cleared by recovery. Readers and registration do not reconcile claims.

## Idle claims

A `deleting` reservation outlives the process that created it. That is not, by itself, an abandoned in-progress deletion. `reconcileIdleDeletionClaims` is a separate writer-gated command. It returns idle `deleting` records to `ready` and does not delete bytes. It leaves `intent`, `quarantined`, `removing`, and `ambiguous` records for recovery. It does not run during reads or registration.

## Commands

```sh
npm run store:gc-preview -- --store ./out/cgp-store --dry-run --grace-hours 24
npm run store:gc-apply -- --store ./out/cgp-store --apply --grace-hours 24
npm run store:gc-recover -- --store ./out/cgp-store --apply
npm run store:gc-reconcile -- --store ./out/cgp-store --apply
npm run store:gc-reconcile -- --store ./out/cgp-store --apply --digest sha256:<hex>
```

Apply, recover, and reconcile refuse to run without `--apply`. Tests use temporary stores only.

## What this does not guarantee

- No distributed lock, networked filesystem, or power-loss barrier beyond same-directory `rename` and an fsynced lifecycle write.
- No automatic deletion during preview, verify, register, or lock.
- No automatic stale-reader reclamation. A reader marker still fails the writer closed.
- No background collector and no project-directory scan.
- No removal of catalog release metadata.
- No proof that a pid which is still alive is the original writer; a live pid always blocks lock adoption.
- JavaScript packages remain trusted in-process. Deletion does not sandbox them.

Study 009 adds composition leases as a retention root this deletion path rechecks. This study does not acquire or release those leases.

## Conformance coverage

Retention pins, wrong tokens, one-shot claim apply, changed bytes, symlinks, active readers, each injected fault boundary, ambiguous pairs, idle-claim reconcile, unmatched writer locks, v1 lifecycle reads, catalog preservation, and re-registration are covered from `src/packages/store-retention.test.ts`.
