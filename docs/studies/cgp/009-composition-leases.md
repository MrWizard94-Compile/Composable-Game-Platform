# CGP Study 009 — Composition leases

**Implementation date:** 2026-11-18  
**Implementation baseline:** `main` at `24fb5d5` (Study 008)  
**Decision status:** Implemented package-store retention root for one live Wasm composition. No package, lock, or lifecycle schema change. Lease files use `cgp.store-composition-lease/1`.

## Purpose

Study 006 releases the store reader after a Wasm snapshot is copied into memory. Study 008 can then quarantine an unpinned object. A running composition must keep those objects out of garbage collection until shutdown. Holding a reader marker for the whole session would block every store writer, including registration and collection of unrelated packages. A composition lease is a separate retention root. It is not a path-backed loader and it is not a sandbox.

## Record

Leases live in `.cgp-store.composition-leases/<leaseId>.json`.

| Field | Rule |
|---|---|
| `schema` | `cgp.store-composition-lease/1` |
| `leaseId` | UUID; the filename is `<leaseId>.json` |
| `token` | at least 16 characters; required to release; omitted from list and from the activation result |
| `pid` | creating process; used only by explicit abandoned release |
| `createdAt` | canonical ISO-8601 timestamp |
| `digests` | non-empty, sorted, unique `sha256:` package-tree digests |

The key set is closed. A missing lease directory means there are no leases. A symlink, a non-directory, an unexpected name, a non-file, or a malformed lease fails closed. Preview and apply throw. They do not skip the file and they do not delete the package object.

The GC root name is `composition:<leaseId>`.

## Acquire and release

`acquireCompositionLease` holds the writer lock, requires every digest to be `ready`, and verifies the package tree before it writes the file. The file is fsynced. The writer lock is then released. The lease does not keep a reader marker and does not copy bytes. A `deleting` or other non-ready object is refused.

`releaseCompositionLease` requires the token. A missing file is already released. A wrong token deletes nothing.

`releaseAbandonedCompositionLease` is explicit. It refuses when pid liveness is `true` or `unknown`, re-reads the token and pid before unlinking, and does not delete package bytes. It does not run during GC, reads, or registration. A live pid is not stolen. Stale leases are not reclaimed automatically, for the same reason stale reader markers are not.

## Wasm activation

`activateWasmProject` does this, in order:

1. Resolve the Wasm-only lock. A JavaScript package throws `Wasm-only project snapshot refuses ... javascript-esm` before a lease or a runtime exists.
2. Acquire one lease for those package-tree digests.
3. Snapshot the packages into memory. On failure, release the lease.
4. Compose on the existing `wasm-isolate` backend. On failure, dispose the backend and release the lease.
5. On shutdown, wait for Foundations shutdown, then `backend.dispose`, then lease release. More than one of those failures is reported together.
6. A composition that returns `ok: false` shuts down before `activateWasmProject` returns, so no lease remains.

The public result includes `leaseId`. It does not include the token. The snapshot still does not keep a store path. After shutdown, an unpinned object can become a GC candidate. A second lease, a local pin, or a project pin keeps it.

## Commands

```sh
npm run store:leases -- --store ./out/cgp-store --action list
npm run store:leases -- --store ./out/cgp-store --action release --lease <uuid> --token <token>
npm run store:leases -- --store ./out/cgp-store --action release-abandoned --apply --lease <uuid>
```

`list` and `release` do not take `--apply` and do not delete bytes. `release-abandoned` requires `--apply` because it drops a retention root. It still does not delete bytes.

## What this does not guarantee

- No path-backed JavaScript package loading. Study 010 imports snapshotted `module.mjs` bytes after an explicit trust opt-in. It still does not load JavaScript from a lockfile path or keep a store path open.
- No automatic stale-lease reclamation and no automatic stale-reader reclamation.
- No automatic garbage collection. Apply remains explicit.
- No multi-host or network-filesystem coordination. Same-host local filesystem only.
- The lease is not a security boundary. It does not sandbox the store owner.
- No browser activation of stored packages.
- Catalog rows are still not deleted.
- A live pid only blocks abandoned release. It does not prove the recorded process is the original owner.

## Conformance coverage

Token release, a second lease, abandoned release under live/unknown/dead pid probes, malformed and unexpected lease files, symlink lease directories, deletion-state refusal, the `store:leases` command, live Wasm retention across `store:gc-apply`, collection of an unrelated unpinned package, and lease cleanup after a failed snapshot or failed policy are covered from `src/packages/store-retention.test.ts` and `src/packages/wasm-activation.test.ts`.
