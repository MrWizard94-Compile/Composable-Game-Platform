# CGP Study 007 — Persistent retention and garbage-collection preview

**Implementation date:** 2026-11-16  
**Implementation baseline:** `feature/store-reader-coordination` after PR #10's reader/writer coordination slice  
**Decision status:** Implemented package-store lifecycle slice. No accepted ADR or package/lock schema changes.

## Purpose

Study 003 defined persistent local and project roots, package object lifecycle states, serialized deletion claims, and conservative mark-and-sweep. Study 006 implemented the cross-process reader/writer gate needed to coordinate those operations.

This slice adds persistent references and a non-destructive collector preview. It deliberately does not delete filesystem content.

## Persistent lifecycle metadata

The content store now has a separate `.cgp-store-lifecycle.json` sidecar using the closed `cgp.local-store-lifecycle/1` schema. The `cgp.local-catalog/1` and `cgp.project-lock/1` formats remain unchanged.

The sidecar records package object states (`ready` or `deleting`), local-import pins by package-tree digest, project pins keyed by caller-supplied project ID, each project's profile and ordered package identities, and token-owned deletion claims.

Every new registration creates a local-retention pin by default. Re-registering an intentionally imported release can restore a previously removed local pin. Explicit local pin/unpin operations are available through the retention CLI.

Project pin creation validates the closed lock schema, checks every module/version/digest against the local catalog, ensures all objects are ready, and fully verifies every package tree before atomically replacing that project's prior pin under the writer gate. Unpin removes only that project root; local pins are independent.

## Legacy-store migration

When the lifecycle sidecar is absent, each catalog-referenced package is conservatively treated as locally retained. An initial ready state and creation time are derived from object directory metadata. This migration is computed in memory for reads and persisted only by an explicit writer operation.

This ensures a pre-existing store does not suddenly make all previously imported packages collectible. Missing catalog objects are reported as missing, never candidates.

Registration persists lifecycle state and the default local pin before committing a new catalog reference. An interruption between those writes can leave a retained orphan, not a catalog record whose content has no retention root.

## Object states and deletion claims

A ready object can transition to deleting only under the exclusive writer marker, after existing readers drain. The claim operation rechecks all local/project roots, verifies the complete package-tree digest, and enforces the configured grace period.

The claim has a random ownership token. While deleting, new package resolution/snapshot reads and new local/project pins are refused. A second claim is refused. Only the matching token can release an unapplied claim.

The claim is a reservation primitive, not permission to remove bytes. No deletion function or apply command is included.

## Dry-run garbage-collection preview

`previewLocalStoreGarbageCollection()` and `npm run store:gc-preview -- --store <path> --dry-run` perform read-only mark analysis under a store reader marker.

For every digest-addressed directory under the canonical package-tree namespace, the preview:

1. validates the package directory and recomputes its package-tree digest;
2. compares actual metadata with all catalog release associations;
3. measures regular package-file bytes without following symlinks or special entries;
4. checks local-import and every project-lock pin;
5. checks the object's ready/deleting state;
6. applies the configured age grace period.

Results distinguish `candidate`, `retained`, `grace-period`, `deleting`, and `invalid`. Reports include digest, byte size, age, release associations, retention roots, missing objects, ignored non-digest entries, root counts, and total candidate bytes.

Catalog release metadata is not itself a content-retention root. An explicitly unpinned release can remain known to the catalog after its local content becomes eligible for future collection; this preserves the distinction between release knowledge and local availability.

The preview does not persist a legacy migration, mutate lifecycle state, create deletion claims, or delete package bytes. It creates/removes only its short-lived reader-coordination marker. The CLI has no apply mode.

## Operator commands

```sh
npm run store:retention -- --store ./out/cgp-store --action pin-project --project-id my-game --lock ./out/local-project.cgp.lock.json
npm run store:retention -- --store ./out/cgp-store --action unpin-project --project-id my-game
npm run store:retention -- --store ./out/cgp-store --action unpin-local --digest sha256:<hex>
npm run store:retention -- --store ./out/cgp-store --action pin-local --digest sha256:<hex>
npm run store:gc-preview -- --store ./out/cgp-store --dry-run --grace-hours 24
```

A generated lockfile does not become a persistent pin automatically; the operator must register it under a stable project ID.

## Failure boundaries and remaining work

This milestone intentionally stops before destructive collection:

- no filesystem deletion, quarantine, or rename-to-trash;
- no completed/deleted tombstone state;
- no crash recovery for a process that dies after claiming an object;
- no automatic stale deletion-claim reclamation;
- no dry-run apply or background collector;
- no power-loss guarantee for directory entry updates;
- no automatic project lock discovery;
- no path-backed JavaScript composition lease or multi-host/network-filesystem coordination.

A stale deletion claim blocks readers and new pin creation until a future recovery process or operator validates and releases it. This favors retention over unsafe deletion.

Study 008 is the destructive continuation. It does not change the preview or claim behavior described above.

## Conformance coverage

- New registrations default to a local-retention root.
- Legacy stores without lifecycle metadata remain locally pinned during preview.
- Project lock pins protect exact package sets independently from local pins.
- Project pins refuse lock identities that differ from the catalog.
- A deletion claim is refused when any persistent root exists.
- A committed deletion claim blocks new resolution and pin creation.
- Only its matching token can release the claim.
- Dry-run preview identifies verified unreferenced content, respects grace, and does not delete bytes or mutate lifecycle metadata.
- Corrupt content is invalid and never a candidate.
- Existing reader/writer, package registration, snapshot, activation, browser, and Foundations suites remain mandatory.
