# CGP Study 006 — Content-store reader coordination boundary

**Research / implementation date:** 2026-11-16  
**Implementation baseline:** `feature/verified-wasm-package-snapshot` after PR #7–#9 merges  
**Decision status:** Implementation note for the first reader-coordination slice. This does not accept a new ADR, implement garbage collection, or establish persistent retention pins.

## Purpose

Study 003 established the need to coordinate package readers, registration, retention, and garbage collection. Study 005 then added a Wasm activation path that verifies every package and copies its Wasm artifact into owned memory before creating the runtime backend.

The current store had one exclusive writer marker for registration, but package verification and project snapshots did not participate in that protocol. A future collector could therefore race a package scan: the reader could resolve a digest path, then lose the directory while hashing or copying the bytes.

This note records the first safe implementation boundary: a cooperative cross-process reader/writer gate around package-file scans and store mutations.

## Implemented coordination contract

The store uses two marker locations below its root:

- `.cgp-store.lock` is the exclusive writer-intent marker. It carries a random ownership token, process ID, and creation time.
- `.cgp-store.readers/<token>.json` contains one short-lived marker per active reader.

Reader acquisition follows a double-check sequence:

1. Wait until no writer marker exists.
2. Create and flush a unique reader marker.
3. Check the writer marker again.
4. If a writer appeared between the first check and marker publication, remove the reader marker and retry without touching package bytes.
5. Otherwise run the complete read operation under that marker and remove it in cleanup.

Writer acquisition follows the reciprocal order:

1. Atomically create the exclusive writer marker.
2. Wait until every reader marker has been removed.
3. Run the mutation only after readers drain.
4. Verify token ownership and remove the writer marker during cleanup.

The double-check closes the acquisition race: a writer either sees an already-published reader marker and waits, or the reader sees the writer marker on its second check and backs out before reading package files.

Registration is now performed under the writer gate. `resolveLocalPackage()`, `verifyLocalStore()`, and `snapshotWasmProjectLock()` hold reader markers while validating package bytes. The project snapshot retains the marker across the entire all-or-nothing scan, then releases it only after every verified package's needed Wasm bytes are owned in memory.

## Why the Wasm activation lease is short-lived

The current Wasm backend posts the snapshot's `Uint8Array` to its worker. The worker instantiates from those copied bytes and does not reopen the package-store directory.

Therefore the current Wasm-only activation path does not need to retain a package-store reader marker for the active composition lifetime. Its required protected interval is:

`catalog/profile/lock preflight → package path checks → full digest verification → owned in-memory snapshot`

After that boundary, the active worker owns the executable bytes and store deletion cannot invalidate the running module.

This is specific to the existing Wasm snapshot adapter. It does not authorize JavaScript ESM activation. A future path-backed JavaScript loader, lazy asset reader, or runtime that reopens package files will need a separate composition-lifetime lease (or a second fully-owned snapshot strategy) held through shutdown and loader release.

## Failure and stale-marker policy

- Readers and writers use bounded waits; timeout is an explicit failure, never permission to proceed.
- A writer marker blocks readers. A reader marker blocks writers.
- A malformed or unknown entry in the reader-marker directory counts as an active reader or fails closed; it is never silently ignored.
- A marker left by process termination is not automatically reclaimed.
- The writer may time out on an orphaned reader marker, release its own writer-intent marker, and report the remaining marker names.
- Manual stale-marker removal requires an operator to verify that the recorded process is no longer active. PID alone is not a safe automatic reclamation proof because of PID reuse and system suspension.
- Marker ownership is checked before normal release. Missing or replaced markers are reported rather than silently ignored.

This is a cooperative same-host coordination protocol using local filesystem exclusive creation. It is not a distributed lock, not a defense against a malicious process with write access to the store, and is not claimed safe on network filesystems.

## Explicit non-goals

This slice does not add:

- persistent project-retention pins or an explicit user keep/unpin model;
- an object-state catalog, deletion tombstones, mark-and-sweep, or destructive GC;
- automatic background cleanup or stale-marker reaping;
- a durable lease held by a running Wasm composition;
- JavaScript ESM or mixed-runtime activation;
- multi-host or network-filesystem coordination;
- power-loss durability guarantees for directory entry updates.

A returned object path from `resolveLocalPackage()` remains an observation, not a retention promise. Code that needs executable bytes must use the verified snapshot boundary. Project locks also do not keep packages present until persistent project pins are implemented.

## Required next implementation steps

1. Add persistent retention roots: explicit local-import pins and project-lock pins with atomic pin/unpin updates.
2. Add package object states and deletion claims so a GC candidate cannot acquire a new reader after being marked deleting.
3. Add a dry-run collector that reports candidates, byte sizes, age, release associations, and every retention root checked.
4. Add explicit apply only after tombstone recovery and failure injection are covered. Do not run automatic GC in this milestone.
5. Keep filesystem deletion outside long metadata transactions; use a recoverable deleting/tombstone state.
6. Add subprocess tests for reader/writer races, process death, stale markers, deletion interruption, and restart recovery before enabling destructive collection.

## Conformance coverage in this slice

- Writer waits for an active reader.
- Writer intent prevents a later reader from entering.
- Stale reader markers cause bounded, fail-closed writer timeout and remain for inspection.
- Stale writer markers cause bounded, fail-closed reader timeout.
- Reader markers are released when the guarded callback throws.
- Existing package registration, integrity, project snapshot, activation, and Foundations suites remain required in CI.
