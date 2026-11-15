# CGP Study 003 — Local Catalog, Content Store, Leases, and Garbage Collection

**Research date:** 2026-11-15  
**CGP baseline:** [c9062eb0bf9a970b22d682ae80ff4fd0b1c7128c](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/c9062eb0bf9a970b22d682ae80ff4fd0b1c7128c)  
**Related research:** CGP Study 001 — Independent Module Package, Artifact, and SDK Contract; CGP Study 002 — Package Identity, Reproducible Archives, and Lock Semantics; Cross-architecture Synthesis 001; O3DE Study 001 — Gems, Packaging, and Distribution.  
**Decision status:** Proposed local package lifecycle and catalog contract. This is not an accepted ADR and does not authorize implementation, database selection, or remote distribution.

## Purpose and decision boundary

Study 001 proposed an independent released-package boundary, a local catalog, and a generated lock. Study 002 proposed a canonical package-tree identity, distinct artifact/package/archive digests, immutable release coordinates, and a safe acquisition pipeline.

This study investigates what happens after a package is validated and how the platform keeps it available, consistent, and safe to use over time.

The questions are:

- What responsibilities belong to the catalog, content store, source index, and Foundations runtime?
- How should an immutable package be placed into local storage?
- How should a release coordinate be registered without exposing partial data?
- How do concurrent readers, writers, installers, and garbage collection coordinate?
- How does a running composition prevent its packages from being deleted?
- What may be deleted, when, and under whose authority?
- How should interrupted installs, process crashes, corrupted objects, and disk-full failures recover?
- What does offline operation guarantee?
- How should local mirrors and future remote repositories relate to content identity and publisher trust?

This study does not:

- add a catalog, content store, database, or garbage collector to the repository;
- choose SQLite, a JSON index, IndexedDB, or another metadata technology;
- choose a canonical archive format;
- add a remote registry, publisher signing, or TUF implementation;
- change the current profile or package descriptor schemas;
- change Foundations' composition, lifecycle, backend, or save behavior;
- claim that filesystem operations are uniformly atomic or durable across every operating system and filesystem;
- authorize an implementation change or accepted ADR.

The recommended design keeps Foundations focused on validating and composing already-resolved packages. Catalog and storage work belongs in a separate package-management layer.

## Executive findings

1. **Separate the catalog from the content store.** The catalog maps release coordinates and source metadata to package-tree digests. The content store holds immutable package trees addressed by those digests. Neither should be embedded in the Foundations composition engine.
2. **Treat package-tree digest as the local package object's address.** Use the Study 002 package-tree digest as the key for an immutable local package directory. Do not key content by module name, version, source URL, or archive filename.
3. **Keep archive downloads in a separate optional cache.** An archive digest identifies transport bytes; a package-tree digest identifies the installed package. Repacking, switching mirrors, or changing compression must not duplicate the logical package object.
4. **Publish the object before publishing its catalog reference.** Stage and validate the package, write it into content-addressed storage, ensure it is complete, and only then commit the catalog release record. A crash may leave an unreferenced object, which is safe to recover or collect; the reverse order could leave a catalog entry pointing to missing bytes.
5. **Make registration idempotent and immutable.** The same moduleId/version plus the same packageTreeDigest is an idempotent registration. The same coordinate plus a different tree digest is a hard immutable-release conflict.
6. **Use transactions for catalog metadata.** SQLite is a credible local Node candidate because it provides committed snapshots and serialized writes, with WAL allowing readers and a writer to proceed concurrently on one host. The metadata backend must remain replaceable; SQLite WAL is not a network-filesystem database.
7. **Treat atomic visibility and power-loss durability as separate guarantees.** A same-filesystem rename can avoid exposing a partially copied object under supported filesystem semantics, but durable publication also requires appropriate flush ordering. Node documents that FileHandle.sync behavior is OS/device-specific.
8. **Use leases for content that is in use or in transit.** An installation lease protects staged or newly published content during registration. A composition lease protects the exact package set from resolution through shutdown and worker release. Lease acquisition and garbage-collection eligibility must be serialized against each other.
9. **Do not rely on TTL alone for active compositions.** Processes sleep, machines suspend, clocks change, and PIDs can be reused. A robust local lease needs process/owner identity and a reclaim strategy; expiry is a recovery aid, not proof that a package is unused.
10. **Start with conservative mark-and-sweep garbage collection.** Retained catalog entries, explicit project pins, active leases, and in-flight operations are roots. Unreferenced objects first become candidates; a grace period and a recheck precede deletion.
11. **Do not run destructive GC automatically in the first local milestone.** Provide a dry-run and an explicit apply operation first. The default should favor availability over disk reclamation until pin and lease semantics are proven.
12. **Keep durable package retention separate from evictable archive caching.** A project-locked package should not disappear because a download cache reached a size limit. A cached archive may be discarded and redownloaded if its trusted digest remains known.
13. **An offline lock is usable only if its exact package content is already local.** A lock does not contain the package bytes. If the locked digest is absent and no network is available, locked execution must fail rather than silently use another version.
14. **A mirror supplies bytes; it does not establish authority.** A mirror may be tried for an expected digest, and another mirror may be tried if the first fails. No mirror may substitute different content. For future remote metadata, use a standard update framework such as TUF rather than inventing CGP's own signature, rollback, and freeze protocol.
15. **Do not merge independent repositories by priority.** If two separately trusted catalogs claim the same moduleId/version with different package-tree digests, resolution is ambiguous and must fail unless the application explicitly selects a source/trust domain.
16. **Keep the release metadata, local availability, and content retention states distinct.** A catalog may know about a release even when the local bytes have been pruned. The user interface and resolver must report that difference accurately.
17. **Plan for recovery as a normal state transition.** Interrupted staging, orphaned objects, missing objects, corrupt objects, and pending deletions should be detectable and repairable without changing a release's identity.
18. **No implementation or accepted ADR changes are justified by this study alone.** The next step after review is to settle the local catalog contract and storage technology, then implement with crash/concurrency tests.

## 1. Current CGP baseline

### 1.1 Existing discovery and resolution

The current `src/foundations/discover-node.ts`:

- scans direct child directories of a caller-provided folder;
- reads `manifest.json`;
- reads `module.wasm` bytes when present;
- does not import JavaScript during discovery;
- exposes a separate explicit `loadInProcessImplementations()` operation that imports `module.ts`.

The current `src/foundations/profile.ts`:

- validates profiles containing `profileId`, name, and module entries;
- pins exact module IDs and semantic versions;
- groups caller-supplied packages by module ID;
- refuses missing modules, multiple packages for one ID, invalid manifests, or version mismatches;
- returns the resolved package array without downloading, installing, or updating anything.

Neither file is a durable package catalog or content store. The existing separation between discovery and explicitly importing executable JavaScript is important and should be preserved.

### 1.2 Foundations is not a package manager

The current `compose()` path accepts already-supplied `ModulePackage[]`, validates and resolves module relationships, and manages execution lifecycle through the selected backend.

Foundations should not become responsible for:

- finding remote catalog sources;
- downloading archives;
- managing local package directories;
- writing package metadata;
- cache eviction or garbage collection;
- deciding which remote repository is trusted;
- pinning projects to a package store.

These belong in a package-management or catalog layer that prepares verified packages before calling the existing Foundations API.

A package manager may use Foundations' validators and profile resolver, but it should not turn Foundations into a network client or a persistent database.

### 1.3 Existing runtime resource ownership is a useful precedent, not the same lease

CGP already gives each composition ownership of its WebAssembly guest workers. `shutdown()` and release behavior are deliberately coordinated so a worker that is still loading, executing, or failing is still accounted for and eventually released.

A package-store lease has a different resource and lifecycle:

- a backend session lease protects runtime workers;
- a package-store lease protects the immutable files needed by a composition or installation.

They should not be conflated. A composition can release a worker session while its package-store lease is still needed for another reason, and the package manager must not assume guest accounting protects files on disk.

### 1.4 Relevant repository limitations

The current repository has no implemented:

- independent package release descriptor;
- package-tree digest calculation;
- catalog or package index;
- immutable local package content store;
- package installation/registration transaction;
- persistent project pins;
- package leases;
- garbage collector;
- archive downloader or extractor;
- remote source trust policy.

The package and store work in Studies 001–002 remains a proposed future contract.

## 2. Separate the objects and responsibilities

A first implementation should distinguish these concepts even if they share one local root folder.

| Object | Responsibility | Mutability |
|---|---|---|
| Source catalog/repository | Says which releases a source offers and where they can be retrieved | Changes over time |
| Local release record | Records a logical moduleId/version and its immutable packageTreeDigest, plus source metadata | Immutable release identity; mutable availability/trust annotations |
| Package content store | Stores validated package trees addressed by packageTreeDigest | Immutable after publication |
| Archive cache | Holds downloaded archive bytes addressed by archiveDigest | Evictable |
| Project lock | Pins the exact package set expected by an application | Updated only by explicit lock regeneration |
| Project retention pin | Tells the local store that a project's locked digest must remain present | Mutable lifecycle record |
| Install lease | Protects an in-progress ingest or install from collection | Temporary |
| Composition lease | Protects packages being resolved or used by an active composition | Held through composition shutdown |
| GC candidate/deletion record | Coordinates safe removal and crash recovery | Temporary/tombstoned state |

### 2.1 Catalog versus content store

The catalog answers:

> Which release is this, what exact content digest belongs to it, and which trusted sources can provide it?

The content store answers:

> Do the exact package bytes identified by this digest exist locally, and can they be verified?

A catalog record is not itself the package. A content-addressed directory does not itself establish the release's publisher, source, license, or trust.

This distinction allows the same package bytes to be used by different profiles, local catalogs, or mirrors without duplicating the content.

### 2.2 Package store versus archive cache

The package store holds the canonical extracted package tree. It is the object resolved by the packageTreeDigest and handed to the package loader.

The archive cache holds transport representations. It is keyed by archiveDigest and may contain:

- a ZIP archive;
- a TAR archive;
- another future approved transport;
- multiple byte-identical or byte-different archives that unpack to the same packageTreeDigest.

Deleting an archive cache entry must not remove an installed package tree. Deleting a package tree must not require deleting unrelated archive bytes.

A first local-only catalog does not need an archive cache at all.

### 2.3 Source identity and trust domain

Each catalog source should have an explicit identity. A repository's module records and trust roots must not be mixed implicitly with another repository's records.

The same packageTreeDigest from two sources is the same content. The same moduleId/version with different packageTreeDigests from two independent sources is a conflict or ambiguity, not an opportunity to choose whichever source happens to be listed first.

Study 002's proposed immutable logical release coordinate remains useful, but a future multi-repository resolver must also define the trust domain from which that coordinate was obtained.

## 3. Proposed local storage layout

The following is illustrative only; exact filenames and metadata technology remain open.

~~~text
<cgp-catalog-root>/
├── catalog.db                  # transactional metadata, if SQLite is selected
├── store/
│   └── packages/
│       └── sha256/
│           └── ab/
│               └── cdef...     # packageTreeDigest, canonical package directory
├── archive-cache/
│   └── sha256/
│       └── 12/
│           └── 345...          # archiveDigest, optional transport bytes
├── staging/
│   └── <operation-id>/          # incomplete ingest/download, never resolvable
├── quarantine/
│   └── <operation-id>/          # suspect or corrupt content pending inspection
└── exports/
    └── catalog-index.json       # optional portable/exported snapshot
~~~

The two-character digest prefix is an illustrative directory fan-out to avoid enormous flat directories. The digest algorithm and profile must be included unambiguously in object identity. A package-tree digest and archive digest must use separate namespaces.

### 3.1 Content-addressed package path

A local package directory can be placed at a path derived from its package-tree digest, for example:

~~~text
store/packages/sha256/<first-two-hex>/<remaining-hex>/
~~~

The directory contains the exact validated release files: `manifest.json`, `cgp-package.json`, the selected runtime artifact, documentation, license text, and supported assets.

The package root directory name is not part of the package-tree digest, consistent with Study 002.

### 3.2 Read-only is a policy, not an absolute security boundary

After publication the package tree should be treated as immutable and should normally be made read-only to ordinary catalog operations.

However:

- filesystem permissions do not make data cryptographically immutable against another process running as the same user or administrator;
- a process with sufficient privileges can change permissions or replace files;
- read-only attributes do not eliminate disk corruption;
- the package-tree digest remains the identity check.

Locked composition must not trust a path merely because its directory name resembles a digest. The store must verify content against the expected packageTreeDigest at an explicitly defined verification point.

### 3.3 Do not introduce hard-link sharing in the first store

Hard links can reduce duplicate storage, but they also create a mutation hazard: if a writable path shares an inode with a supposedly immutable object, changes through one name alter the bytes seen through the other.

The first package store should use ordinary copied files in its own content-addressed directory. More advanced deduplication can be considered after immutable ownership and platform behavior are proven.

## 4. Catalog metadata model

### 4.1 Minimum logical records

The metadata backend should represent at least:

**Catalog sources**
- stable source/catalog ID;
- source kind (local directory, local index, or future remote repository);
- source location or configuration reference;
- trust-domain identity;
- enabled/disabled state;
- refresh metadata where applicable.

**Releases**
- moduleId;
- exact semantic version;
- packageTreeDigest;
- runtime kind, entrypoint and ABI/export data derived from cgp-package.json;
- artifactDigest;
- license and release metadata;
- source/catalog IDs that advertise the release;
- immutable-release status or conflict diagnostics.

**Content objects**
- packageTreeDigest;
- current state: staging, ready, deleting, missing, corrupt, or quarantined;
- package file count and total unpacked size;
- verification timestamp and verification profile version;
- local storage location derived from digest, not stored as an arbitrary executable path.

**Archive objects (optional)**
- archiveDigest;
- media type;
- exact byte size;
- local cache location;
- packageTreeDigest verified after extraction;
- cache/retention state.

**Pins and leases**
- project/profile retention references;
- user keep references;
- active composition leases;
- in-progress installation leases;
- deletion claims/tombstones.

The schema names and exact normalization rules need a later implementation design.

### 4.2 Catalog record and local availability are different states

A release may be known to the catalog even when its package bytes are not locally installed.

For example:

- a source index advertises `org.example.beacon@1.0.0`;
- the record points to `sha256:...` packageTreeDigest;
- the local content store does not currently contain that digest;
- the package can be acquired online from a trusted source, but cannot be used offline until it is fetched and verified.

The user interface and APIs should report `known`, `present`, `verified`, `missing`, or `corrupt` explicitly. A catalog lookup that returns metadata must not imply the package is ready to compose.

For a locally imported package, the initial `catalog add` operation should create a default local-retention pin, so the user's intentional import remains available offline until explicitly unpinned or removed.

### 4.3 Release immutability

For a given moduleId/version coordinate:

- the first successful registration stores its packageTreeDigest;
- registering the same digest is idempotent;
- registering a different digest is a hard conflict;
- a corrected package requires a new module version;
- changing a source URL, adding a mirror, or adding another archive representation does not change package identity;
- deprecation, revocation, and source availability are separate annotations and do not rewrite the content digest.

Use a unique metadata constraint on the release coordinate within the defined global or source-scoped identity domain. The exact identity domain is an open question for multi-catalog operation; it must not be decided by listing order.

### 4.4 Suggested metadata technology

A local Node catalog needs transactional operations for:

- immutable coordinate registration;
- package-object state changes;
- project pins;
- lease acquisition/release;
- GC candidate selection and tombstones;
- recovery after a crash.

SQLite is a strong candidate for the metadata index. Its transaction model ensures separate connections see committed transactions rather than partial writes. SQLite WAL allows readers to proceed while a writer appends changes, but only one writer operates at a time. WAL relies on same-host shared memory and is not supported over a network filesystem.

That profile is a reasonable match for a local, single-machine catalog with many reads and occasional package registrations or GC operations. It is not a suitable database file to share between multiple machines on a network volume.

This is not a final technology decision. If CGP needs browser persistence, IndexedDB is a separate storage adapter. If the first CLI is intentionally single-process, a carefully serialized file-backed index could prove the package lifecycle, but it must not pretend to support concurrent writers. A generated JSON export can be useful without being the transactional source of truth.

The key design requirement is a transactional metadata interface; database choice is a later platform/dependency decision.

## 5. Registration and package installation

### 5.1 Registration sequence

The registration algorithm must make incomplete objects invisible to ordinary catalog readers.

Recommended order:

~~~text
Source package directory or downloaded archive
    |
    v
Create unique operation and staging area
    |
    v
Copy/receive bounded bytes into staging
    |
    v
Validate paths, entry types, file sizes, and package structure
    |
    v
Compute packageTreeDigest and artifactDigest
    |
    v
Verify expected digests and release coordinate
    |
    v
Acquire digest/coordinate registration serialization
    |
    v
Publish complete object into content-addressed store
    |
    v
Commit release record + local retention pin transaction
    |
    v
Report registered and locally available
~~~

Never execute JavaScript or instantiate WebAssembly during acquisition or registration. Static validation and runtime smoke testing remain separate operations as defined by Study 001.

### 5.2 Snapshot input into staging before hashing

Do not calculate a digest from a source directory and then copy the source later. A source tree could change between those operations, causing the stored files to differ from the bytes that were hashed.

Instead:

- enumerate source files without following symlinks;
- copy each accepted regular file into a private staging tree;
- calculate hashes from the bytes actually written to staging;
- validate the complete staged tree;
- compute packageTreeDigest from that staged tree;
- publish only that verified staged snapshot.

If files are being edited concurrently during the copy, the staging process can still observe different moments for different files. The authoring tool should therefore build/export a release directory that is not being edited during registration, or detect source changes during the copy and require retry. The staged bytes, not the mutable original path, define the package that is registered.

### 5.3 Object publication before catalog reference

The filesystem object and metadata transaction cannot generally be treated as one portable atomic transaction.

Prefer the safe failure direction:

1. Verify and stage the package.
2. Publish the complete package object under its digest-derived path.
3. Ensure the object is complete and durable to the level supported by the selected platform.
4. Commit the catalog release row and default retention pin in one metadata transaction.

If the process dies between steps 2 and 4, a complete but unreferenced object remains. It can be reused by a later registration or removed by recovery/GC after a grace period.

If the metadata is committed first and the process dies before publishing the package, the catalog can advertise a locally available object that does not exist. Avoid that order.

### 5.4 Do not assume an atomic rename is a complete transaction

On POSIX filesystems, rename within the same filesystem can make a completed path change atomically visible. Linux documents atomic replacement semantics for `rename()`, but the details include replacement behavior and filesystem constraints. Node's `FileHandle.sync()` requests a flush, with the actual behavior being OS/device specific.

Consequences for CGP:

- create staging under the same storage volume/filesystem as the final store;
- do not use a cross-volume copy as if it were an atomic rename;
- do not use a check-then-rename sequence without serialization or a no-clobber strategy;
- do not assume rename itself flushes file contents or directory entries against power loss;
- do not assume an existing object path can safely be overwritten;
- use the selected platform's appropriate file and directory flush sequence where crash durability is required;
- document the actual durability guarantee for each supported platform/filesystem.

The Node API does not offer a single portable high-level "durably publish this directory without replacement" transaction. The implementation must be explicit about the supported semantics and test failure behavior on supported operating systems.

### 5.5 Registration conflict behavior

| Concurrent operation | Required outcome |
|---|---|
| Same coordinate, same packageTreeDigest | Idempotent success; one release record |
| Same coordinate, different packageTreeDigest | One immutable record wins; other registration fails with conflict |
| Different release coordinates, same packageTreeDigest | Reuse the content object; keep separate release records |
| Same digest installed by two processes | One object becomes ready; other verifies/reuses it |
| Catalog listing during registration | Sees either no release record or the complete committed record, never half-written metadata |
| GC races with a registration | Installation lease/transaction prevents collection of content being committed |
| Existing digest path contains different bytes | Mark corruption/conflict and quarantine; never overwrite blindly |

The metadata backend should enforce release-coordinate uniqueness, not rely only on a preflight read.

## 6. Concurrency model

### 6.1 Catalog reads and metadata writes

A reader should observe a consistent catalog snapshot. It must not see a release row without a ready content object, or a partially updated row while registration is running.

SQLite transactions provide a useful example of this property. In WAL mode, readers use a stable snapshot while a writer appends a transaction; writers are serialized. A `SQLITE_BUSY` or equivalent contention outcome should be handled with a bounded retry/backoff policy and a useful diagnostic, not by dropping a release update silently.

### 6.2 Two layers of concurrency control

There are two different resources to coordinate:

- **Metadata operations:** release uniqueness, pins, lease rows, object state, and GC claims.
- **Filesystem operations:** finalizing a digest path, removing files, copying staged content, and verifying local bytes.

A database transaction does not by itself make a multi-file filesystem change atomic. A filesystem rename does not by itself commit catalog metadata. Use a coordinated protocol:

- a transactional metadata backend serializes logical state changes;
- a per-digest or per-coordinate claim prevents competing object finalization;
- staging and finalization use filesystem-safe operations;
- a database row records which objects are ready, deleting, or in recovery;
- readers resolve only objects marked ready and held by a valid lease.

The coordination implementation may use database claims, process locks, filesystem primitives, or a combination. It must work across multiple processes if the CLI and a running game can access the same catalog.

### 6.3 Duplicate-install race

Two processes may independently receive the same packageTreeDigest at the same time.

Recommended behavior:

1. Each uses a unique staging operation.
2. Each computes and verifies the expected tree digest.
3. Both contend for finalization of the same digest.
4. One publishes the complete object.
5. The other detects that the object already exists, verifies it against the digest, discards its own staging directory, and reuses the ready object.
6. Both may attempt catalog coordinate registration; the metadata uniqueness rule makes same-coordinate/same-digest idempotent and same-coordinate/different-digest a conflict.

No writer may truncate, replace, or rewrite an already-published digest directory.

### 6.4 Avoid holding a global write transaction while copying large files

Package copies and hashing may be slow. Do not hold the catalog's global writer lock while reading multi-gigabyte files or downloading archives.

Use short metadata transactions to create an installation operation/lease, record the verified object state, and publish the release. Perform expensive staging and hashing outside the catalog writer transaction, protected by an operation record or lease. Keep only the logical commit and state transitions inside transactions.

## 7. Leases and active composition safety

### 7.1 Why leases are necessary

Garbage collection cannot rely only on catalog release metadata. A package may be actively loading or executing while the user removes a catalog pin or starts a cleanup operation.

Containerd uses leases to keep resources alive when clients may still use them even though the resources are not otherwise referenced. It makes the caller responsible for managing the lifetime of the lease. This maps well to CGP's package store, with CGP-specific lease ownership and lifecycle rules.

### 7.2 Lease types

**Install lease**
- Created before a staged package begins publication.
- Protects staged or newly published bytes until the catalog release transaction commits or the operation aborts.
- Released after the package is either ready and rooted or the failed staging data is cleaned.

**Project retention pin**
- Persistent reference created when a project installs or locks a package set into the local catalog.
- Protects exact package-tree digests required by the project's lock.
- Removed only by an explicit project-uninstall/unpin operation or a new committed lock update.

**Catalog retention pin**
- Created by default when a user explicitly imports a package into their local catalog.
- Preserves local-only package bytes for offline use.
- Removed through an explicit unpin/remove operation, not automatically because a package is old.

**Composition lease**
- Acquired for every selected package before package files are read for locked resolution/composition.
- Held across registration, initialization, active dispatch, save/restore hooks that may use package resources, and shutdown.
- Released only after the composition's shutdown path and backend session release complete.
- Must be idempotently releasable and safe when shutdown is called more than once.

**Maintenance lease or operation claim**
- Protects verification, repair, or deletion operations from conflicting work.
- Must not let a stale maintenance claim block the store indefinitely after process death.

### 7.3 Lease acquisition must race safely with GC

A dangerous race would be:

1. a composition looks up a package;
2. GC decides the package is unused;
3. the composition starts reading the package;
4. GC deletes it during load or execution.

The package manager must serialize lease acquisition and GC eligibility.

Proposed rule:

- the operation that acquires a composition lease and confirms the object is ready must do so in the same metadata transaction or equivalent serialized critical section used by GC to mark an object deleting;
- if the object is already marked deleting, lease acquisition fails and the package manager must not read it;
- if lease acquisition commits first, GC sees the active lease and cannot mark the object deleting;
- package deletion begins only after a state transition that prevents new leases.

This closes the logical race between a fresh reader and a collector.

### 7.4 Lease identity and stale-process recovery

A lease record may need:

- unique lease ID;
- lease type;
- process/application instance identity;
- owner/project or composition identity;
- packageTreeDigest;
- creation time;
- heartbeat/expiry metadata for diagnostics and recovery;
- lifecycle status.

A PID alone is not sufficient because processes terminate and PIDs may be reused. A TTL alone is not sufficient because a process can be suspended for longer than the TTL or the machine clock can change.

A robust local Node implementation should use OS-backed process ownership/lock semantics where the supported operating systems allow it, with a process-start identity to reduce PID-reuse ambiguity. A heartbeat and grace interval can assist recovery, but the policy must avoid expiring a live composition lease solely because a machine was asleep.

The exact cross-platform locking approach remains open. If a stale lease cannot be safely proven dead, the correct initial behavior is to retain the package and report a stale lease for explicit repair rather than delete potentially live content.

### 7.5 Tie composition lease to actual composition lifetime

The composition lease must not end when profile resolution returns.

It must remain held until:

- all modules have completed shutdown or failure cleanup;
- the backend has released its guest workers/resources;
- all package-store readers owned by that composition have closed;
- the package manager has completed the corresponding lease release.

A wrapper/runner above Foundations can acquire the package lease, pass verified ModulePackage inputs into `compose()`, and release the lease after the returned shutdown path completes. The lease lifecycle should not require Foundations to know where files came from.

A caller that abandons a composition without calling shutdown can leave a lease behind. The package manager needs process-exit cleanup plus stale-process recovery; it must never assume application code always reaches a `finally` block.

## 8. Garbage collection and retention

### 8.1 Retention roots

The collector should mark an object live if any of these references it:

- a catalog-retention pin for an explicitly imported local release;
- a project-retention pin for an installed/locked application profile;
- an active composition lease;
- an active installation lease;
- a user-created explicit keep pin;
- an active verification/repair/maintenance operation;
- a configured, documented retention policy root.

The collector should not infer that a running process has no package dependency merely because its current working directory is elsewhere.

A lockfile stored in a project directory is not automatically visible to a catalog located elsewhere. The CLI must register a project pin or the GC command must be given explicit project roots. Do not promise lock protection without a mechanism for discovering or registering those locks.

### 8.2 Mark-and-sweep

Recommended algorithm:

1. Begin a short metadata transaction.
2. Read all retained roots and active leases.
3. Mark referenced package objects.
4. Select unmarked, ready objects older than the configured grace period.
5. Atomically mark candidates `deleting` so no new lease can be acquired.
6. Commit the metadata transaction.
7. Remove the content-addressed directories outside the transaction.
8. Record deletion completion in a second metadata transaction.
9. If deletion fails or the process crashes, retain the deleting/tombstone state for recovery and retry.

Do not hold the catalog's writer transaction while recursively deleting large directories.

### 8.3 Why use a grace period

A grace period protects against:

- a newly imported package not yet pinned by the caller;
- metadata propagation or delayed project pin creation;
- interrupted registration recovery;
- stale but potentially still-active operation state;
- operator mistakes during a catalog removal.

The initial GC should show what would be removed and why. A dry-run report must list digest, size, module coordinate associations, candidate age, and the roots checked.

### 8.4 First milestone: explicit GC only

Do not start with a background automatic collector.

The first local store should support:

- `gc --dry-run`;
- `gc --apply` with explicit confirmation;
- stale staging cleanup;
- recovery of previously marked deletions;
- a report of pinned and leased objects;
- refusal to delete objects with uncertain lease ownership.

Automatic retention quotas and background cleanup can follow after project pins, active leases, and crash recovery are tested.

### 8.5 Archive cache eviction is separate

Archive cache entries are transport objects; package directories are verified content objects.

The archive cache may use a size-bounded LRU or other cache policy after ensuring no active download/extraction lease refers to the archive.

The package store should not be subject to the same cache eviction rules. A project lock or local catalog retention pin should keep exact package content available, even if an associated archive is deleted.

### 8.6 Catalog removal and historical metadata

A `catalog remove` operation should remove the local retention pin and/or source advertisement as explicitly requested. It should not bypass active composition or project pins.

Possible behavior:

- remove the local source record but retain release metadata for diagnostics;
- mark the release no longer advertised by that local source;
- remove the catalog-retention pin;
- retain package bytes while any project pin, active lease, or keep pin remains;
- leave final deletion to GC.

For a remote catalog, removing a source record from local configuration should not automatically erase a package already pinned by a project lock. Source removal and package-content removal are different user actions.

The exact UX and tombstone policy remain open.

## 9. Offline operation, sources, and mirrors

### 9.1 What a lock does and does not guarantee

A lock records the exact package identity. It does not embed the package bytes.

Offline locked composition succeeds only if every required packageTreeDigest is already present and verified in the local package store.

Offline behavior should be explicit:

- if all locked objects are locally present and valid, resolve and compose without network access;
- if any locked object is missing, fail with a missing-package diagnostic;
- do not choose another module version;
- do not contact the network in an operation explicitly marked offline;
- do not turn a cache miss into an implicit upgrade.

This is a useful separation between lock determinism and availability.

### 9.2 Mirror behavior

A future remote catalog may provide multiple archive URLs for one immutable release.

For a requested expected archive digest:

- try an eligible mirror;
- verify exact byte size and archiveDigest before extraction;
- if it fails, record the failure and try another mirror for the same expected object;
- after extraction, verify the expected packageTreeDigest;
- never accept a different digest merely because a mirror says the requested file is unavailable.

A bad mirror should be able to cause an availability failure or denial of service, not silently change which package is executed.

### 9.3 Content verification versus repository trust

A digest proves that bytes match an expected digest. The digest does not prove that the expected digest came from the intended publisher.

For a local-only catalog, the catalog is part of the user's local trust boundary. The application owner controls which directories they add and which package digests their project lock accepts.

For remote repositories, the trust problem expands:

- repository metadata can be replayed or rolled back;
- an attacker may freeze a client on old metadata;
- mirrors may be compromised or unavailable;
- several repositories may make conflicting claims;
- publisher identity and signing-key rotation require a root of trust.

The Update Framework (TUF) is a mature standard model for signed repository metadata, delegations, consistent snapshots, timestamp freshness, rollback/freeze resistance, and mirrors. The current TUF specification is version 1.0.37, last modified 2026-10-08. It treats mirrors as file providers, while trusted metadata supplies the expected content information and freshness checks.

CGP should use a standard TUF implementation if remote package updates become a supported security feature. It should not create its own signature envelope and assume that a verified SHA-256 digest alone prevents stale or unauthorized repository metadata.

### 9.4 Do not mix independent trust roots

TUF models repositories as separate trust domains. Its specification states that trusted content from different repositories is not automatically mixed; the application decides how multiple repositories relate.

CGP should apply the same caution.

If two sources claim:

~~~text
org.example.beacon@1.0.0
~~~

but advertise different `packageTreeDigest` values, profile resolution must report an ambiguity or immutable-release conflict. It must not use:

- first repository wins;
- last repository wins;
- highest source priority without an explicit policy;
- arbitrary ordering of catalog files.

The future design may add explicit catalog/source selection to profiles or locks. That decision is still open. Until then, multiple different digests for one coordinate must fail closed.

### 9.5 Expired remote metadata and offline operation

Freshness expiration is important when refreshing remote repository state. An expired TUF timestamp should prevent the client from treating an old metadata snapshot as current.

That does not mean a previously locked and locally verified package must become unavailable merely because the network is offline or a remote timestamp later expires. The application can continue to use its previously accepted lock and local package object under its own policy, while refusing to refresh or newly resolve from expired remote metadata.

This distinction should be documented when remote repositories are implemented: freshness controls new trust decisions; local locked content availability is a separate property.

## 10. Recovery and failure behavior

The content store and metadata index are not a single atomic storage system. Recovery must understand intermediate states.

| Failure point | Expected durable state | Recovery behavior |
|---|---|---|
| Process dies while copying into staging | Incomplete staging only; no release record | Remove after operation is proven stale |
| Download interrupted | Partial archive in staging/cache temp only | Discard or resume only under an explicit chunked-download protocol |
| Path or manifest validation fails | No published object and no release row | Report validation failure; remove staging |
| Process dies after object publication but before catalog commit | Complete but unreferenced content object | Reuse after verification or collect after grace period |
| Catalog transaction fails before commit | No committed release reference | Leave verified object for retry/recovery; do not claim registration succeeded |
| Process dies after catalog commit | Release points to previously published object | Startup verifies object presence; locked resolution can verify again |
| Disk full during staging | Incomplete staging only | Abort, clean or retain a marked operation for cleanup |
| Disk full during object publication | Object not marked ready | Quarantine or remove partial publication; never expose through catalog |
| Disk full during metadata commit | Transaction must be rolled back or reported unknown until reopened/recovered | Re-read authoritative metadata before retrying |
| Object disappears after registration | Release metadata remains; local availability is missing | Report unavailable; reacquire the exact digest if a trusted source exists |
| Object bytes change on disk | Digest verification fails | Mark corrupt/quarantine; do not compose |
| Process dies during GC after mark-deleting | Object is in deleting/tombstone state | Resume deletion on next recovery pass; reject new leases |
| Process dies during physical deletion | Partial directory deletion may remain | Finish deletion; do not expose as ready |
| Lease release fails | Object remains protected or appears stale | Retry/recover lease; favor retention over unsafe deletion |
| Metadata database corrupts | Catalog index unavailable or suspect | Do not infer releases from arbitrary store directories; restore backup or rebuild only from trusted sources |
| Mirror returns different archive bytes | Digest mismatch | Reject that mirror and try another for the same expected digest |

### 10.1 Recovery must not invent catalog authority

An orphaned directory whose name resembles a package-tree digest is not sufficient authority to recreate a release record. A recovery tool can validate the tree and report an orphan. It should only recreate a catalog association when the module coordinate and expected digest are supplied by a trusted source or explicit local registration.

Similarly, a release record whose object is missing must not be silently redirected to a different digest.

### 10.2 Repair is not overwrite

A corrupted content-addressed object must not be repaired by writing new bytes into the same published directory.

Instead:

- mark the current object corrupt;
- prevent new leases;
- reacquire or re-import the expected package;
- verify it produces the exact expected packageTreeDigest;
- publish the verified replacement under the same digest address only after the corrupt object is safely quarantined/removed;
- preserve diagnostics and the original release identity.

If the re-import produces different bytes, it is not a repair of that release.

### 10.3 Database durability has assumptions

SQLite describes atomic commit and WAL durability in terms of storage flushes and filesystem behavior. No metadata database can guarantee durable writes if the OS, filesystem, storage controller, or hardware violates the assumptions its synchronization protocol requires.

The catalog must distinguish:

- process-crash consistency;
- operating-system crash/power-loss durability;
- protection against external tampering or storage corruption.

Those are different guarantees, and the exact contract depends on the chosen metadata backend and supported filesystems.

## 11. Security and operational boundaries

### 11.1 Trust hierarchy

A future package lifecycle has distinct trust layers:

1. **Source/catalog trust:** Is this repository authorized to advertise this release?
2. **Metadata freshness/trust:** Is the release metadata authentic and current?
3. **Transport integrity:** Do downloaded bytes match the expected archive digest and size?
4. **Package integrity:** Does the staged directory match the expected packageTreeDigest?
5. **Runtime artifact integrity:** Does the selected executable file match artifactDigest?
6. **Runtime isolation and policy:** Does the chosen backend actually enforce its declared limits and capabilities?
7. **Code behavior:** Does the module do what the application owner expects?

Passing one layer does not prove the next. A digest-valid package can still be malicious JavaScript. A structurally valid Wasm module can still consume its allowed resources or exploit a runtime vulnerability within the limits of the host's threat model.

### 11.2 Catalog and store paths are not network URLs

Content-addressed storage paths should be derived internally from validated digest values. Do not accept arbitrary filesystem paths from catalog metadata as executable package locations.

Remote URLs should be handled by a separate acquisition adapter with explicit protocol and redirect policy. If remote fetching is added, the implementation must also consider server-side request forgery and local-network access where an untrusted catalog can supply URLs.

### 11.3 Quarantine and diagnostics

Quarantine should be separate from ready content. A quarantined object must not appear in normal resolution.

Diagnostics should include:

- module coordinate when known;
- expected and actual digest;
- source/catalog ID;
- operation ID;
- failure stage;
- whether the package was ever marked ready;
- whether it is currently leased or pinned;
- whether recovery or operator action is required.

Avoid logging secrets embedded in source credentials or sensitive URL query parameters.

## 12. Suggested local catalog API boundary

The following is a conceptual API, not a proposed public TypeScript signature.

~~~text
Catalog
  listSources()
  addSource()
  removeSource()
  listReleases()
  inspectRelease(moduleId, version)
  registerLocalPackage(directory)
  verifyPackage(packageTreeDigest)
  acquirePackageLease(digests, owner)
  releasePackageLease(leaseId)
  pinProject(projectId, lock)
  unpinProject(projectId)
  removeLocalRetention(moduleId, version)
  garbageCollect({ dryRun })
  recover()
  verifyStore()
~~~

A separate resolver/runner layer would:

1. validate the profile and lock;
2. acquire leases for all packageTreeDigests;
3. load verified packages from the content store;
4. verify runtime descriptor fields and artifactDigest;
5. call Foundations profile resolution and composition;
6. retain the package lease until composition shutdown and backend release;
7. release leases on every failure path.

Foundations continues to receive `ModulePackage[]`. It should not need the catalog database, filesystem path, source URL, or archive digest.

## 13. Recommended implementation sequence after ADR review

1. **Freeze the catalog/storage boundary.** Define Catalog, ContentStore, ArchiveCache (optional), ProjectPin, and PackageLease responsibilities.
2. **Select the local metadata backend.** Evaluate SQLite for the Node CLI, an IndexedDB adapter for browser persistence if required, and the actual package/dependency costs. Do not share a SQLite WAL database over a network filesystem.
3. **Implement digest-addressed directory storage.** Use the Study 002 packageTreeDigest path and immutable publication rules.
4. **Implement staging and registration.** Snapshot input to staging, validate, hash, publish the object, then commit catalog metadata and a default local-retention pin.
5. **Add deterministic conflict/idempotency tests.** Same coordinate/same digest, same coordinate/different digest, duplicate object installs, and cross-catalog conflicts.
6. **Add project retention pins.** A project lock must have an explicit reference in the local catalog or be supplied as a known GC root.
7. **Add package leases.** Cover installation, verification, profile resolution, active composition, and shutdown. Tie acquisition/GC state changes to the metadata transaction protocol.
8. **Implement recoverable explicit GC.** Dry-run first, then mark-and-sweep with grace periods, tombstones, and deletion recovery. No background automatic GC initially.
9. **Add offline lock verification.** Exact local digest succeeds; missing or corrupt digest fails without network or version substitution.
10. **Add mirror acquisition only after local behavior is reliable.** Use verified digests, exact-source metadata, and standard remote update security when applicable.
11. **Add archives after the format is selected.** Archive cache and extraction become transport adapters; package-tree identity remains unchanged.
12. **Add remote repositories and TUF integration only when remote updates become a supported product requirement.**

## 14. Required adversarial and lifecycle tests

The local store must be tested for more than happy-path registration.

### Registration and concurrency
- Two processes register the same coordinate and same digest simultaneously.
- Two processes register the same coordinate with different digests.
- Two processes publish the same packageTreeDigest from separate staging directories.
- Catalog reads execute while a registration transaction is open.
- GC attempts to claim an object while a registration lease is active.
- A package changes in its source directory while a staging copy is in progress.
- The final digest path already exists and contains valid bytes.
- The final digest path already exists but contains altered bytes.

### Lease and composition lifetime
- A composition acquires a package lease and GC runs before the first module hook.
- A composition starts loading while GC is selecting candidates.
- The application calls shutdown twice.
- A guest worker is still loading when shutdown begins.
- Shutdown throws but backend release still completes.
- The application process terminates without releasing the lease.
- The machine suspends longer than the heartbeat interval and resumes.
- A stale PID is reused by a different process.
- One composition uses the same package object as another composition.

### Crash and filesystem behavior
- Process termination at every step of the registration sequence.
- Disk full during staging, object publication, metadata commit, and GC deletion.
- Power loss or forced termination after file flush but before metadata commit.
- Power loss or forced termination after catalog commit.
- Rename or directory promotion fails.
- The store is on a different volume from the temporary source.
- File or directory permissions deny cleanup.
- A directory disappears or becomes corrupt between metadata read and file open.

### Integrity, recovery, and GC
- A stored manifest, descriptor, asset, and runtime artifact are each altered independently.
- A package object is missing but its release record remains.
- A complete object exists without a catalog release record.
- A deletion tombstone exists but some files remain.
- A lease row remains after the owning process has died.
- A project lock is not registered as a pin and the CLI warns about the risk.
- A dry-run lists every candidate and every retention root checked.
- GC never deletes a leased or pinned digest.
- An archive cache eviction never deletes a package object.
- A corrupt object is quarantined and never selected for locked composition.

### Offline and multiple source behavior
- An offline locked composition uses an already present package successfully.
- An offline lock with one missing package fails and does not upgrade.
- A mirror returns the wrong archive digest.
- A mirror returns the correct archive digest but the extracted package tree is wrong because the expected descriptor is inconsistent.
- A mirror is unavailable and the next mirror provides the same expected archive.
- Two catalogs advertise the same coordinate with different packageTreeDigests.
- Remote metadata is expired or rolled back; new resolution is refused while an existing verified local lock remains governed by the application's offline policy.

The implementation should use fault injection or subprocess termination at defined state transitions. Unit tests alone cannot establish crash recovery.

## 15. Research references

### Content-addressed objects and distribution

- [OCI Image Specification — Content Descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) — content descriptors bind media type, digest, size, and optional retrieval URLs; consumers verify bytes against the digest.
- [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md) — digest-addressed blob retrieval, range support, chunked upload sessions, cancellation, and cross-repository blob mounting.
- [LLVM — Content Addressable Storage](https://llvm.googlesource.com/llvm-project/+/refs/heads/release/23.x/llvm/docs/ContentAddressableStorage.md) — describes CAS as immutable and useful for deduplication and representing inputs/outputs by stable content identity.

### Transactions, concurrency, and filesystem behavior

- [SQLite — Isolation In SQLite](https://sqlite.org/isolation.html) — committed transaction isolation and serialized writes.
- [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html) — readers/writer concurrency, one writer, checkpoint behavior, and the same-host/network-filesystem restriction.
- [SQLite — Atomic Commit](https://www.sqlite.org/atomiccommit.html) — transaction commit/recovery and assumptions about filesystem synchronization and storage hardware.
- [Node.js v26.13.1 — File System API](https://nodejs.org/api/fs.html) — rename operations and FileHandle.sync; sync behavior is OS/device-specific.
- [Linux man-pages — rename(2)](https://www.man7.org/linux/man-pages/man2/rename.2.html) — atomic path replacement behavior, replacement constraints, and filesystem-specific errors. This is Linux/POSIX evidence, not a universal Windows guarantee.

### Leases and garbage collection

- [containerd — Garbage Collection](https://github.com/containerd/containerd/blob/main/docs/garbage-collection.md) — GC roots, resource references, lease lifecycle, expiry, and the caller's responsibility to keep in-use resources leased.
- [npm — Cache](https://docs.npmjs.com/cli/cache/) — content-addressable cache integrity verification and its explicit warning that a cache is not a durable persistent package store.

### Remote catalog freshness and mirrors

- [The Update Framework Specification, version 1.0.37](https://theupdateframework.github.io/specification/latest/) — repository roles, signed targets, snapshot consistency, timestamp freshness, rollback/freeze resistance, mirror behavior, and non-recoverable-update prevention.
- [TUF — Metadata Roles](https://theupdateframework.io/docs/metadata/) — snapshot metadata provides a consistent view; timestamp metadata provides a frequently refreshed freshness signal and can be distributed through mirrors.

## Conclusion

CGP should keep its catalog and content store outside Foundations. The catalog manages immutable release records and mutable source/retention metadata; the content store holds package-tree-digest-addressed directories; archive bytes, if later supported, live in a separate evictable cache.

Registration should stage, validate, hash, publish the complete object, then commit metadata. Leases must protect installation and active composition lifetimes. Garbage collection should be conservative, explicit, and recoverable. A locked package must never silently change because a source or mirror changed.

The recommended first milestone is a local-only content store and transactional catalog with project pins, composition leases, recovery, and dry-run GC. Remote mirrors, signed repository metadata, archive distribution, and automatic retention should come only after that lifecycle is proven.

No implementation or accepted ADR changes are made by this study.