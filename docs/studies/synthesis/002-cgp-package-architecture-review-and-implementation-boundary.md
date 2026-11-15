# CGP Package Architecture Review 001 — Cross-Study Decision Map and Implementation Boundary

**Research date:** 2026-11-15  
**Documentation baseline:** [245abcaea541a99506d5a92279b04eecf311f62d](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/245abcaea541a99506d5a92279b04eecf311f62d)  
**Implementation baseline:** [c9062eb0bf9a970b22d682ae80ff4fd0b1c7128c](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/c9062eb0bf9a970b22d682ae80ff4fd0b1c7128c). The intervening commits add documentation only; no Foundations implementation changed.  
**Inputs reviewed:** CGP Studies 001–003; Cross-Architecture Synthesis 001; ADRs 0001, 0003, 0007, 0008, 0010–0014; package discovery, profile resolution, host fingerprint, save compatibility, backend, and status documentation.  
**Decision status:** Cross-study architecture review and ADR preparation. This document is not an accepted ADR and does not authorize implementation.

## Purpose

The three CGP package studies were developed in sequence:

- **CGP Study 001 — Independent Module Package, Artifact, and SDK Contract** defines the package authoring and release boundary.
- **CGP Study 002 — Package Identity, Reproducible Archives, and Lock Semantics** defines package-tree identity, artifact and archive digests, and exact lock behavior.
- **CGP Study 003 — Local Catalog, Content Store, Leases, and Garbage Collection** defines local storage, registration, retention, concurrency, recovery, and future remote-source behavior.

This review compares them as one system, checks them against accepted CGP architecture, corrects places where the proposals need tighter terminology or lifecycle semantics, and separates decisions that can be adopted together from those that should remain open.

The desired outcome is not to freeze every future feature. It is to identify a small, coherent first implementation that proves independent packages without pulling distribution, persistence, remote trust, or storage policy into Foundations.

## Executive decision

The three studies are architecturally compatible if the following refinements are made before ADR approval:

1. **Keep Foundations as the composition/runtime core.** Package acquisition, catalog metadata, content storage, project pins, and garbage collection remain in a package-management layer outside Foundations.
2. **Keep the five conceptual package objects separate:** authoring project, released package, catalog/source record, content-store object, and application profile/lock.
3. **Use three digest fields with distinct meanings:** artifactDigest, packageTreeDigest, and archiveDigest. Study 002 refines the ambiguous packageDigest term from Study 001.
4. **Treat packageTreeDigest as the immutable local content-store address.** A module release coordinate maps to one packageTreeDigest. The same bytes may be advertised by several sources or encoded in several archives without duplicating the content object.
5. **Keep a profile as human-authored intent and a lock as generated exact resolution.** This extends ADR 0008 without changing the accepted profile schema.
6. **Do not add package hashes directly to the existing composition fingerprint.** The current fingerprint is also compared against save documents. A distinct package-set identity and, if needed, runtime execution identity should be introduced.
7. **Register the object before committing the catalog reference.** Stage, validate, hash, publish a complete digest-addressed directory, then commit release metadata and the initial local-retention reference.
8. **Serialize every new retention root against deletion.** Composition leases alone do not close the GC race. Project pins, local-retention pins, explicit keep pins, install leases, and active leases must all participate in the same eligibility protocol.
9. **Use leases for package lifetime, not guest resource accounting.** The existing backend session and ADR 0014 worker reservations remain separate mechanisms. A package lease wraps composition from before package loading until shutdown and backend release complete.
10. **Make the first catalog local-only and conservative.** No required archive format, remote registry, TUF integration, signing service, automatic GC, or multi-host shared database.
11. **Treat SQLite as a candidate for a same-host Node catalog, not a foregone conclusion.** If selected, WAL is not a multi-host network-share database. Keep the storage interface narrow and avoid abstracting hypothetical backends.
12. **Separate package correctness from runtime trust.** Digest verification establishes byte identity, not safety. JavaScript remains trusted in-process code; WebAssembly retains its existing isolated backend and policy checks.

The proposed architecture is a package manager and verified content store that prepares exact package inputs for Foundations. Foundations continues to validate composition relationships and manage runtime execution.

## 1. Evidence and repository baseline

### 1.1 The current implementation already has a useful seam

Current package discovery in src/foundations/discover-node.ts:

- scans module folders supplied by the caller;
- reads each manifest;
- reads raw WebAssembly bytes when module.wasm exists;
- does not import module.ts during discovery;
- exposes loadInProcessImplementations as a separate, explicit import operation.

Current profile resolution in src/foundations/profile.ts:

- validates a closed profile document;
- pins module IDs and exact semantic versions;
- chooses packages from an already available array supplied by the caller;
- refuses a missing module, duplicate package for an ID, invalid manifest, or version mismatch;
- does not fetch, install, upgrade, or write catalog state.

Current compose() receives ModulePackage objects and manages composition resolution and lifecycle. It does not know the path from which a package came or how it was acquired.

This is the desired integration seam. A package manager should prepare verified ModulePackage objects and pass them into existing Foundations APIs.

### 1.2 The current host fingerprint has a second consumer

The current fingerprint function in src/foundations/host.ts includes:

- backend ID;
- ordered module IDs and versions;
- resolved Slot and contributor structure;
- dependency edges;
- contribution IDs and order.

The save document stores this fingerprint. restoreSave compares it with the runtime fingerprint and emits a warning when they differ. It still matches save slices by module ID.

This matters because Study 001 suggested adding package digest to the composition fingerprint. Study 002 more carefully distinguishes package/composition identity from runtime execution identity. The current save behavior confirms that the existing fingerprint cannot be casually redefined as a complete package checksum.

This review proposes explicit additional identities in Section 5 and preserves the existing field semantics until an ADR and migration decision say otherwise.

### 1.3 Accepted architecture relevant to package management

The key accepted ADRs establish:

- **ADR 0001:** the host is TypeScript-first, headless, and uses JSON data contracts; Foundations is not a game engine.
- **ADR 0003:** discovery, validation, resolution, prepare, registration, initialization, run, and caller-requested shutdown are separate lifecycle stages. Foundations does not own a game tick loop.
- **ADR 0007:** src/foundations/index.ts is the supported public authoring import. The public surface does not imply a sandbox.
- **ADR 0008:** a profile expresses module IDs and exact versions, resolves against a catalog the caller already has, and refuses incomplete or ambiguous selections. A profile is not a world.
- **ADR 0010:** all module hooks execute through an ExecutionBackend. In-process JavaScript is explicitly trusted and is not sandboxed.
- **ADR 0011:** discovery reads manifests and raw Wasm bytes without instantiating guests; guest execution is isolated in workers owned by a composition.
- **ADR 0012:** each composition has execution sessions; cross-backend release waits for both backend sessions; aggregate budgets and backend accounting are distinct.
- **ADR 0013:** the portable Wasm module is a produced artifact. The current build/check scripts are part of the existing authoring workflow.
- **ADR 0014:** guest reservations and backend session cleanup have explicit single-refund and release semantics.

The package design should extend these contracts rather than fold their responsibilities into a new universal subsystem.

### 1.4 Current code has no package store

The current repository does not implement a content-addressed package directory, a durable release catalog, a generated package lock, a package-store lease, a project retention pin, or garbage collection. The local-package studies are proposals.

No code or accepted ADR changes occurred in this review.

## 2. Unified layered architecture

The three studies describe one lifecycle. This review consolidates it into the following layers.

~~~text
AUTHORING PROJECT
  Source · SDK · tests · build configuration
        |
        v
RELEASE PACKAGE
  manifest.json · cgp-package.json · one runtime artifact
        |
        v
STATIC VALIDATION + PACKAGE IDENTITY
  Paths · schemas · artifactDigest · packageTreeDigest
        |
        v
CATALOG / SOURCE METADATA
  moduleId + version -> packageTreeDigest
  Source authority · release metadata · availability
        |
        v
CONTENT-ADDRESSED STORE
  Immutable package tree keyed by packageTreeDigest
        |
        v
PROJECT PROFILE + GENERATED LOCK
  Intent -> exact package set and digests
        |
        v
PACKAGE MANAGER / LOCKED RESOLVER
  Verify · pin · acquire package leases · load package inputs
        |
        v
FOUNDATIONS
  Manifest validation · capability/Slot resolution · lifecycle
        |
        v
EXECUTION BACKEND
  Trusted in-process JS and/or isolated Wasm guests
~~~

The archive cache, when one is justified, is a transport cache beside the content store. It does not sit between the catalog and the package identity.

The catalog and content store may share a root directory and metadata backend, but they are distinct responsibilities:

- The catalog records which release coordinate refers to which package digest, from which source, under which trust domain.
- The content store holds the actual validated package files at a digest-derived location.
- A package manager coordinates the filesystem and metadata transitions.
- Foundations receives already-selected package objects and continues to own composition semantics.

### 2.1 The responsibilities that must not collapse together

| Responsibility | Owner | Must not become |
|---|---|---|
| Build and package source | Authoring SDK/toolchain | Runtime discovery guesswork |
| Module behavior and capability contract | manifest.json + Foundations validator | Catalog metadata |
| Runtime artifact selection | cgp-package.json | Filename inference |
| Release source and download locations | Catalog/source metadata | Runtime manifest fields |
| Exact package file identity | packageTreeDigest | Archive URL |
| Exact executable identity | artifactDigest | Module semantic version |
| Transfer-object identity | archiveDigest | Installed package identity |
| Human application selection | Composition profile | Package download list |
| Resolved package selection | Lock | Automatic upgrade policy |
| Persistent package lifetime | Store pins and leases | Backend guest memory accounting |
| Composition graph and lifecycle | Foundations | Package acquisition graph |
| Runtime trust and execution limits | Execution backend + policy | Package signature or digest |

### 2.2 Preserve the distinct graphs

Cross-Architecture Synthesis 001 identified separate graphs for distribution, capability dependencies, Slot contributions, lifecycle order, and internal simulation/work scheduling.

This package architecture must retain those distinctions:

1. **Source/acquisition graph:** which catalogs or repositories advertise releases and provide package bytes.
2. **Release/content mapping:** which immutable package-tree digest belongs to a module release coordinate.
3. **Profile/lock selection:** which exact packages an application has selected.
4. **Composition dependency graph:** CGP capabilities and Slot connection requirements.
5. **Slot contribution structure:** which module contributes to which parent-owned Slot.
6. **Lifecycle order:** deterministic register and initialize order, with reverse shutdown.
7. **Internal simulation/work schedule:** caller-defined module behavior, outside Foundations.

A capability requirement must not be treated as a package-manager dependency. A release source must not be treated as a Slot provider. A lock must not silently invent a dependency solver that changes the composition graph.

## 3. Cross-study reconciliation

### 3.1 Study 001 and Study 002: packageDigest is refined, not an additional concept

Study 001 used package digest as a broad reference to exact package content. Study 002 separates the three byte objects:

- artifactDigest: exact runtime executable bytes;
- packageTreeDigest: complete canonical released package tree;
- archiveDigest: exact transfer archive bytes.

Study 002 should be treated as the refined terminology. New schemas should not introduce the unqualified field packageDigest.

The package descriptor, runtime manifest, catalog, lock, and content store should use these explicit names consistently.

### 3.2 Study 001 and Study 003: a catalog record is not an installed package

Study 001 introduced a local catalog release record and profile lock. Study 003 separates:

- the source's advertised release;
- local release metadata;
- actual content-store availability;
- archive cache availability;
- project retention;
- active composition use.

A release may be known but not locally installed. Therefore a successful catalog listing is not evidence that offline composition can work.

Resolution must report at least the distinction between known, present, verified, missing, and corrupt content. A lock may name a valid digest even when the corresponding local object is missing; that is a failed offline availability check, not permission to substitute another package.

### 3.3 Study 002 and Study 003: package identity is independent of transport

These studies agree that one package-tree digest may be represented by more than one archive digest. Archive bytes are a transport object; the installed canonical tree is the package object.

The first local milestone can omit archives entirely. Directory registration is sufficient to prove package validation, identity, catalog registration, content storage, lock resolution, and composition.

### 3.4 Study 003 refines release registration order

The correct safety direction is:

1. Snapshot source files into private staging.
2. Validate the staged files and compute digests from the actual staged bytes.
3. Publish a complete package object under its packageTreeDigest.
4. Commit the release record and local retention reference only after the object is complete.

This favors an orphaned content object after a crash over a committed catalog reference to missing content.

The object and catalog metadata are not one portable filesystem/database transaction. Their state transitions need explicit recovery logic.

### 3.5 Study 003 needs a stronger GC race rule

Study 003 correctly says a composition lease must be serialized against a collector marking an object as deleting. The same rule must apply to *every operation that creates a retention root*.

A project pin, user keep pin, catalog-retention pin, install lease, or composition lease cannot be added after an object has been marked deleting while the deletion is in progress.

The metadata transaction that marks an object deleting must check all roots. The transaction that creates a new root must require the object to be ready. If deletion has already been claimed, the new pin/lease must fail and the package must be reacquired or restored after deletion completes.

This is a necessary refinement: protecting only composition leases leaves a race where a project can pin a package after the collector has decided it is unreferenced.

## 4. Decision map: what can be adopted together

The following groups are suitable for a coordinated ADR review. The statements below are recommendations, not accepted architecture.

### 4.1 Core package contract

**Recommended direction: adopt as one package-format decision.**

- Keep manifest.json as the existing CGP runtime manifest.
- Add cgp-package.json as a versioned package descriptor.
- Keep one execution artifact per release in package-format version 1.
- Support the proposed wasm-core and javascript-esm runtime kinds only when their host/runtime support is actually provided.
- Use explicit entrypoint and ABI/export declarations.
- Do not require authoring source, build scripts, node_modules, or guest.json in the release.
- Ship documentation and applicable license material in the release package.
- Reject unknown descriptor fields and runtime kinds.

The existing moduleApi compatibility range, package format version, artifact ABI, and SDK version are distinct version axes. They must not be treated as interchangeable.

### 4.2 Package identity

**Recommended direction: adopt the three-digest model and freeze the canonical tree-hash profile before coding.**

- artifactDigest hashes the exact executable file bytes.
- packageTreeDigest hashes all regular release files at their validated relative paths.
- archiveDigest hashes the exact archive bytes when archives exist.
- packageTreeDigest is the immutable logical content identity used by the local package store.
- Archive format remains deferred.
- The package-tree hash profile requires conformance test vectors before implementation is accepted as interoperable.

The tree digest includes manifest, descriptor, runtime artifact, README, license material, and shipped assets. Changing any included file changes packageTreeDigest. With immutable moduleId/version coordinates, that is a new package release and requires a new version rather than silently replacing published bytes.

### 4.3 Release coordinate and source policy

**Recommended default: a moduleId plus exact version has one globally consistent packageTreeDigest within the application's trusted CGP namespace.**

- Multiple sources may advertise the same release.
- If they advertise the same packageTreeDigest, they point to the same logical release.
- If they advertise different packageTreeDigests for the same coordinate, resolution fails with a conflict or ambiguity.
- Source listing order and arbitrary priority must never pick one automatically.
- A mirror may provide bytes, but it cannot redefine the release digest.
- A private fork should normally use a different moduleId. A future explicit source-qualified override may be considered, but it must be visible in the lock and trust policy.

This is the safest default because a source location is provenance and acquisition metadata, not the identity of the code. The exact namespace governance and source-qualified override policy still require ADR discussion.

### 4.4 Profile and lock

**Recommended direction: preserve ADR 0008 and add a separate generated lock.**

- The human profile continues to list module IDs and exact versions.
- The lock records exact packageTreeDigest and artifactDigest values, runtime kind, entrypoint, ABI or named JS export/trust classification, and the profile semantic digest.
- Lock generation is deterministic and explicit.
- Locked resolution refuses any missing, conflicting, corrupt, unsupported, or digest-mismatched package.
- Catalog updates never rewrite a lock.
- A deliberate lock update displays changes for review.

The lock is an exact-resolution record, not a trust root. Its changes must be reviewed through the application's authenticated source-control process.

### 4.5 Local catalog and content store

**Recommended direction: implement local-only first.**

- The catalog records immutable release identity plus mutable source/availability annotations.
- The content store holds immutable package directories at digest-derived locations.
- Archive bytes, if added later, are kept in a distinct evictable cache.
- Registration is idempotent for the same coordinate and digest, and a hard conflict for the same coordinate with different content.
- The content object is published before catalog metadata is committed.
- Local import creates an explicit default retention root so the user does not lose an intentionally imported package to cleanup.

Do not select database technology solely from the document design. Evaluate whether SQLite is the right Node-local backend for the supported process/filesystem model.

### 4.6 Package retention and GC

**Recommended direction: add leases and pins as store lifecycle, not Foundations behavior.**

- Installation lease protects ingest and publication.
- Project pin protects every package selected by an application's committed lock.
- Local-retention pin protects packages explicitly imported by a user.
- Composition lease protects the exact package set from locked resolution through shutdown and backend release.
- GC roots are all pins, leases, active operations, and explicit keep references.
- GC marks deleting only after checking roots and preventing new roots.
- First GC is explicit, dry-run by default, and has recoverable deletion tombstones.
- Automatic background cleanup is deferred.

The package lease and the execution backend session are separate. One protects files, the other protects live guest workers and runtime reservations.

## 5. Four identities: a necessary correction to the fingerprint proposals

This is the most important cross-study refinement.

### 5.1 Existing composition fingerprint

The current composition fingerprint is a structural/runtime compatibility marker. It includes backend ID and the deterministic composition structure. The save format records it, and restoreSave warns when the stored value differs.

Do not add packageTreeDigest or archiveDigest directly to this existing field in the first package implementation.

If README.md or LICENSE changes, packageTreeDigest changes. That should identify a different released package, but it should not automatically imply that the module's saved game state is incompatible. Conversely, if the executable code changes while the manifest and contribution layout stay identical, a package identity change is important even if the existing structural fingerprint remains unchanged.

The save system needs a deliberate compatibility design, not an incidental consequence of changing a hash input.

### 5.2 Package-set identity

Add a distinct identity for the exact package set selected by a lock.

Conceptual contents, sorted deterministically by moduleId:

- moduleId;
- exact version;
- packageTreeDigest;
- artifactDigest;
- runtime kind;
- selected entrypoint;
- Wasm ABI or JavaScript named export and trusted-in-process classification.

This identity answers:

> Which exact released packages and executable artifacts were selected?

It does not include the archive URL or archiveDigest. Repacking or mirroring the same package must not change the resolved package set.

A provisional name is packageSetIdentity. The serialization and hash mechanism should reuse the approved canonical JSON/tree-hash conventions rather than invent another ad hoc concatenation.

### 5.3 Composition structure identity

The existing fingerprint already describes a structural composition result. It can remain the field used for current save mismatch warnings until an explicit save-compatibility ADR says otherwise.

A future rename or schema evolution may make its role clearer, but do not silently change its contents as part of package management.

### 5.4 Runtime execution identity

A separate runtime identity may combine:

- package-set identity;
- the composition structure identity;
- backend implementation/version;
- relevant execution-policy values;
- host API and guest runtime/ABI version.

It answers:

> Under which exact selected code, composition structure, backend, and effective execution policy is this runtime operating?

It is not necessarily a save compatibility hash. Execution policy changes may affect trust or performance without invalidating module-owned JSON save slices.

### 5.5 Identity relationship

| Identity | Main contents | Used for |
|---|---|---|
| artifactDigest | Raw runtime artifact bytes | Executable integrity |
| packageTreeDigest | Complete canonical released package files | Release immutability and CAS address |
| archiveDigest | Raw transport bytes | Download verification |
| packageSetIdentity | Exact selected package coordinates and digests | Lock-resolved code set |
| existing composition fingerprint | Backend ID and resolved composition structure | Current save mismatch warning and structural identification |
| runtime execution identity | Package set + composition structure + backend/runtime/policy | Runtime diagnostics and exact execution context |

The last three are proposed distinct identities, not three replacements for the existing field in one implementation change.

## 6. Package manager and Foundations boundary

### 6.1 Proposed package-manager responsibility

A package-management layer should:

1. Read and validate a project profile and lock.
2. Locate the exact release records from configured local sources.
3. Acquire project/composition leases before any package can be collected.
4. Retrieve the exact package content from the local store or an approved source.
5. Verify packageTreeDigest and artifactDigest.
6. Validate manifest and package descriptor.
7. Create the ModulePackage inputs required by Foundations.
8. Call the existing profile resolution/composition APIs.
9. Keep the package lease alive through the returned shutdown operation.
10. Release the package lease after Foundations has completed shutdown and backend release.

The exact public API names are open. A conceptual entrypoint could be a locked composition runner rather than making the caller manually coordinate store paths and lease IDs.

### 6.2 Foundations remains intentionally unaware

Foundations should not receive:

- SQLite connections;
- catalog source URLs;
- archive objects;
- content-store root paths;
- package installation transactions;
- GC state;
- project-retention references.

Foundations continues to receive already-verified package objects. This keeps the composition host usable in memory, in tests, in a browser viewer, and in a future environment without the Node local catalog.

### 6.3 Static validation and execution remain separate

Static validation should not import JavaScript or instantiate WebAssembly.

The current scripts/check-wasm-module.ts is a runtime integration/smoke test because it composes the guest and executes its lifecycle. That is useful, but it is not the static package validator.

The future toolchain should expose separate operations for:

- static validation and digest calculation;
- runtime smoke testing under an explicit backend/policy;
- locked production composition.

Package integrity does not change the trust rules:

- JavaScript remains trusted in-process and is not sandboxed.
- WebAssembly remains subject to existing import, memory, table, worker, time, and aggregate resource policy.
- A digest proves exact bytes, not safe behavior.

### 6.4 Package lease wrapper and backend shutdown

The existing host shutdown calls its execution session's release path, and ADR 0012 requires the cross-backend session to await release of both sides. The package-manager wrapper should await that existing shutdown completion and only then release the package-store composition lease.

If composition fails before a live result is returned, the package manager must still release the lease after the failed load/session cleanup has completed.

This avoids changing the guest resource-accounting mechanism merely to protect package files.

## 7. Storage and transaction refinements

### 7.1 Content store object path

Use packageTreeDigest as the object address. The digest algorithm/profile identifier must be encoded unambiguously in the address namespace.

Use ordinary copied files in the first store. Do not introduce hard-link-based deduplication until the store's immutability model is proven.

Read-only permissions are a helpful operational policy, not a cryptographic boundary. The digest must remain the verification authority.

### 7.2 Registration algorithm

The combined safe flow is:

~~~text
Create operation record + installation lease
        |
        v
Copy source package into private staging
        |
        v
Validate all staged files and metadata
        |
        v
Compute artifactDigest + packageTreeDigest
        |
        v
Acquire short per-digest finalization claim
        |
        v
Publish complete object without replacing an existing object
        |
        v
Commit release record + local retention pin
        |
        v
Mark operation complete and release install lease
~~~

Hash the actual staged files, not the mutable authoring source followed by a later copy. If the authoring source changes during staging, the tool should detect instability where practical and require a clean export/retry.

### 7.3 No-clobber publication requires an explicit primitive

A generic rename call is not a complete "publish only if absent" primitive. Current Node documentation states that fs.rename overwrites an existing destination file; directory and platform behavior also differs.

The implementation must not perform an unsafe check-then-rename race and assume it is portable.

Possible coordination approaches include:

- a short metadata transaction with a unique per-digest publishing claim;
- a per-digest lock that is safe across the supported local processes;
- a no-clobber publication primitive supported on each target platform.

The selected approach must make competing writers either publish one complete object or verify and reuse the already published object. No process may overwrite a different object at a digest path.

### 7.4 Database and filesystem are separate failure domains

The content object and release metadata are not one atomic transaction.

Prefer this failure direction:

- complete object published but catalog commit absent: safe orphan, detectable and reusable or collectible;
- catalog release committed but object not published: invalid state, which the registration protocol must prevent.

Do not hold a global database writer transaction while downloading or hashing large packages. Stage and hash outside it. Use short serialized transactions for finalization claims, release uniqueness, object state, and root references.

If SQLite is selected, its transaction isolation means separate connections see complete committed transactions, and writers are serialized. WAL permits readers to continue while a writer appends changes, but WAL requires all participating processes to be on the same host and is not a network-filesystem database.

### 7.5 Recovery states

The combined store state model should distinguish at minimum:

- staging;
- publishing;
- ready;
- deleting;
- missing;
- corrupt;
- quarantined.

The exact schema can differ, but no incomplete or deleting object can be returned by ordinary locked resolution.

A complete orphan can be verified and reused or collected after a grace period. A corrupt object must be quarantined and must never be repaired by blindly overwriting the published directory. A valid replacement must independently verify to the expected packageTreeDigest.

### 7.6 Durability guarantee must be scoped

Atomic visibility, process-crash recovery, and power-loss durability are different properties.

Node's FileHandle.sync requests a flush, but its implementation is operating-system and device specific. Node's rename documentation points to platform rename semantics and notes overwrite behavior for an existing destination file.

Therefore the first implementation should state exactly which operating systems and local filesystems it supports, what it promises after a process crash, and what it has actually tested for power-loss behavior. It must not describe a portable rename plus database commit as a fully atomic disk transaction.

## 8. Project pins, lock updates, and GC race closure

### 8.1 A lock in source control is not automatically a local retention root

A project lock is portable and can be committed to source control. The local catalog's project pin is not automatically portable; it exists only in that machine's package store.

The package manager must register or reconcile local project pins from the project's actual lock. A CLI must not claim that a lock is protected from GC until the local store has a corresponding root or an explicit project-lock scan mechanism.

### 8.2 Updating a project lock spans two persistence systems

The project lock file and local catalog database cannot generally participate in one cross-platform atomic transaction.

Use a safe conservative order:

1. Resolve and validate the complete new lock.
2. Add local project pins for every package in the new lock.
3. Atomically replace the project lock file using the project's supported filesystem protocol.
4. Confirm the new lock is readable and has the expected digest.
5. Remove pins that are no longer required by the committed lock.
6. Reconcile stale project pins after interruption.

A crash before step 3 leaves extra pins but preserves the old lock's packages. A crash after step 3 but before step 5 leaves extra pins, which wastes storage but does not delete required content. The dangerous inverse order could release an old package before the new lock is safely committed.

### 8.3 Every root creation must race safely against GC

The GC state transition and root creation must be mutually serialized.

- If a project pin or lease commits first, GC sees the root and cannot mark the object deleting.
- If GC marks the object deleting first, a new pin or lease fails.
- New operations must not revive an object while physical deletion is in progress.
- After deletion completes, the package must be reacquired and verified before a new pin can be committed.

This applies to install leases, local-retention pins, project pins, user keep pins, composition leases, and maintenance operations.

### 8.4 Composition lease lifetime

Acquire package leases before locked package resolution reads from the store, not after module loading begins.

Hold them through:

- package verification/loading;
- registration and initialization;
- active calls and save/restore operations that may require package resources;
- shutdown hooks;
- backend session release and worker termination.

Only after shutdown has completed should the package manager release its composition lease. Release must be idempotent and must cover composition-failure cleanup.

The store lease does not replace ADR 0014's backend accounting. It protects a different resource.

### 8.5 Garbage collection sequence

A conservative collector should:

1. Start a short metadata transaction.
2. Read every retention root and active lease.
3. Select old unreferenced ready objects.
4. Mark candidates deleting so new roots cannot be created.
5. Commit the claim.
6. Delete the directory outside the transaction.
7. Commit deletion completion.
8. Retain a tombstone/recovery state if the process fails or physical deletion is incomplete.

The collector must not hold a database writer transaction while recursively deleting large package directories.

### 8.6 First GC is manual

The first implementation should provide:

- dry-run listing with package digest, size, age, and reason;
- explicit apply;
- stale staging cleanup only after the operation is proven inactive;
- recovery of interrupted deletions;
- refusal to delete packages with uncertain lease ownership;
- a report of pins and leases.

Automatic background GC, quotas, and LRU policies should wait.

## 9. Source trust and remote distribution boundary

### 9.1 Local source first

A local directory/catalog is enough to validate the first complete workflow. No remote account, public registry, package marketplace, or network resolver is needed.

For offline operation:

- every package in the lock must exist and verify locally;
- if one is absent, locked resolution fails;
- no network is contacted in explicit offline mode;
- no different version or digest is substituted.

The lock records identity, not the package bytes themselves.

### 9.2 Mirrors are transport providers

For a future remote source, each mirror must serve the expected object. The client verifies exact archive size and archiveDigest, safely extracts, then verifies packageTreeDigest.

A mirror may be unavailable or malicious. It can cause failed acquisition, but it cannot change the selected release.

### 9.3 TUF is future remote trust, not local-store scope

The current TUF specification is version 1.0.37, last modified 2026-10-08. Its metadata roles and client workflow address signed repository metadata, snapshot consistency, threshold keys, freshness, rollback checks, and freeze checks. It also specifies how mirror locations are used as file providers while trusted metadata controls expected content.

If CGP implements remote mutable catalogs and secure updates, it should evaluate a conformant TUF implementation rather than design a proprietary signing/freshness protocol.

TUF is not needed to prove local catalog registration or content-addressed storage. Do not add it to the first package milestone.

### 9.4 Source conflict policy remains an ADR question

Recommended default: one release coordinate in CGP's trusted namespace maps to one packageTreeDigest.

Two sources claiming the same coordinate with the same digest are equivalent advertisements of the same content. Two sources claiming different digests are a hard conflict. Do not choose by source order or priority.

A future source-qualified override is possible but must be an explicit lock/trust decision. It must not be introduced as a hidden fallback.

## 10. Compatibility with accepted ADRs

| Accepted record | Existing invariant | Package architecture compatibility | Required care |
|---|---|---|---|
| ADR 0001 | Headless TypeScript host, JSON contracts, no engine-specific world assumptions | Compatible | Package manager remains outside the core |
| ADR 0003 | Explicit lifecycle and caller-owned run/step semantics | Compatible | Package lease wrapper waits for shutdown |
| ADR 0007 | One supported Foundations author import; no implied sandbox | Compatible | SDK exposes only documented public API; JS remains trusted |
| ADR 0008 | Exact module ID/version profile, refuse ambiguity, no automatic upgrade | Compatible | Lock is a separate generated exact-resolution record |
| ADR 0010 | ExecutionBackend controls module execution; in-process is not sandboxed | Compatible | Package store does not claim to enforce execution permissions |
| ADR 0011 | Wasm discovery reads bytes but does not instantiate; per-composition workers | Compatible | Static validation and guest execution remain separate |
| ADR 0012 | One composition session and coordinated release across backends | Compatible | Package lease surrounds, but does not replace, backend sessions |
| ADR 0013 | Portable Wasm artifacts are produced and checked; license terms are explicit | Compatible with extension | New package descriptor and JS release pipeline require new documentation |
| ADR 0014 | Guest resource reservations, refunds, and release cleanup are precisely accounted | Compatible but distinct | Do not mix storage leases with guest reservation ledgers |

No current accepted ADR needs to be weakened for the package architecture.

New ADRs are required because a package descriptor, digest profile, content store, catalog transaction protocol, lock schema, and storage lease lifecycle are new accepted contracts—not mere refactors of existing code.

## 11. ADR-ready decision groups

The following is the recommended ADR sequence. These are decision packages, not pre-approved records.

### ADR candidate A — Independent module release package and identity

Decide:

- package descriptor filename and closed schema;
- package-format versioning;
- one-artifact release rule;
- Wasm and JavaScript artifact declarations;
- package-tree digest profile and path rules;
- artifactDigest and packageTreeDigest semantics;
- inclusion of README/license/assets in package identity;
- immutable moduleId/version mapping.

Exit condition: example JavaScript and Wasm release packages can be independently validated from a clean directory, and package-tree digest test vectors are specified.

### ADR candidate B — Local catalog and content-addressed store

Decide:

- catalog/store responsibilities and API seam;
- global release-coordinate uniqueness default;
- local source identity and conflict behavior;
- package object location derived from packageTreeDigest;
- registration ordering and idempotency;
- metadata technology and supported process/filesystem model;
- crash recovery for object publication and catalog commit.

Exit condition: a complete package can be registered locally without partial visibility or release-coordinate replacement.

### ADR candidate C — Profile lock, package-set identity, and locked resolver

Decide:

- lock schema and lock version;
- semantic profile digest mechanism;
- exact runtime fields mirrored from the package descriptor;
- packageSetIdentity contents;
- treatment of the existing composition fingerprint and save warnings;
- lock update/review and local package resolution behavior;
- project pin registration and reconciliation.

Exit condition: a clean project can generate a lock, move to another checkout with the lock, verify exact package bytes from a trusted local source, and refuse drift.

### ADR candidate D — Package leases, retention, recovery, and GC

Decide:

- install, project, local-retention, composition, and maintenance lease types;
- process identity and stale lease recovery;
- pin/lease/GC serialization;
- mark-deleting and deletion tombstone protocol;
- explicit GC defaults and grace period;
- project lock versus local pin reconciliation;
- supported crash durability level.

Exit condition: a package in use cannot be removed; interrupted installation/deletion is recoverable; uncertain liveness favors retaining content.

Archive transport, remote source security, TUF, signatures, provenance, automatic GC, multi-host storage, and source-qualified release overrides should not be bundled into these first ADRs.

## 12. First implementation milestone

The first implementation should prove a complete independent local package journey, not build a universal registry.

### Milestone 1 — Independent local package and verified content store

**Goal:** Take a module built outside the CGP repository, validate it, derive stable package identity, register it locally, retrieve it by exact digest, and provide verified inputs to the existing composition host.

Recommended scope:

1. Finalize package format v1 descriptor and directory layout.
2. Build the JavaScript starter to a self-contained module.mjs, without a repository-relative import.
3. Retain the current Wasm release shape with explicit cgp.abi/1 descriptor.
4. Implement strict static package validation without importing JavaScript or instantiating Wasm.
5. Freeze the Study 002 package-tree digest profile and publish conformance vectors.
6. Calculate artifactDigest and packageTreeDigest.
7. Implement local content-store put, inspect, verify, and get-by-digest operations.
8. Implement a local catalog with immutable coordinate registration and idempotency/conflict behavior.
9. Publish the complete object before catalog metadata; record and recover orphaned objects.
10. Add a minimal local workflow to validate, register, list, inspect, and verify one independent package.
11. Compose the verified package using the existing Foundations API. Do not change Foundations to perform catalog I/O.

The local metadata backend should be selected after checking the Node version floor, SQLite binding/runtime support, packaging size, cross-process requirements, and test matrix. SQLite is a strong candidate for a same-host local catalog but is not yet the architecture itself.

### Explicit non-goals for Milestone 1

- no ZIP/TAR archive distribution;
- no remote catalog or public registry;
- no npm publishing of the root repository;
- no public account or publisher identity service;
- no TUF implementation or package signing;
- no lock format change until package identity is stable;
- no automatic garbage collection;
- no multi-host/network-share package store;
- no hot reload or package replacement;
- no new Foundation execution or isolation guarantee.

### Milestone 1 acceptance tests

- A module authored in a clean project can build a release without importing CGP source.
- Static validation does not execute the module.
- A change to any released package file changes packageTreeDigest.
- The same files at different parent directory names produce the same packageTreeDigest.
- An artifact byte change changes artifactDigest.
- A package with an invalid path, special entry, symlink, missing descriptor, or unsupported runtime kind is refused.
- A local registration is visible only after the object is complete and verified.
- Re-registering the same coordinate and digest is idempotent.
- Re-registering the same coordinate with a different digest fails without replacing the original.
- Two different release coordinates with identical package trees reuse one content object.
- A package tree whose stored bytes change is marked corrupt and never silently composed.
- A crash after object publication but before catalog commit leaves a detectable orphan, not a catalog entry that falsely claims local availability.
- Existing Foundations tests and composition behavior remain unchanged.

## 13. Deferred architecture and the reason for each deferral

| Capability | Defer until | Reason |
|---|---|---|
| Archive format and reproducible archive profile | Supported target OS/runtime and archive tooling are explicit | Transport must not define package identity |
| Remote catalog | Local catalog/store/lock behavior is proven | Avoid network trust and availability complexity prematurely |
| TUF integration | Remote mutable repository metadata is supported | Signed freshness, rollback, and delegation are not needed for local-only |
| Publisher signing and provenance enforcement | Release publication and trust policy exist | Digests alone are integrity, not authenticity; policy must have a trust root |
| Automatic GC | Leases and project pins pass adversarial tests | Incorrect deletion is worse than extra disk use |
| Multi-host catalog/store | A real deployment requires shared storage | SQLite WAL is same-host and shared filesystems introduce another consistency model |
| Browser-persistent package store | A browser-hosted editor/runtime must own packages locally | Current browser console can remain a viewer over shared Foundations behavior |
| Multiple artifacts per release | A demonstrated target-selection requirement exists | One artifact per release avoids variant selection ambiguity |
| External runtime dependency graph | Self-contained artifacts prove insufficient | Capability requirements, build dependencies, and runtime linkage are separate graphs |
| JavaScript sandbox | A backend with enforceable isolation is designed and validated | Package format does not grant sandboxing |
| Hot module replacement | Package generations and state migration policy are designed | A package-store update is not a safe live runtime replacement |
| Source-qualified same-version overrides | A concrete private-fork/multi-source use case exists | Default global coordinate consistency is simpler and safer |

## 14. Unresolved questions to carry into ADR review

1. Is moduleId/version globally unique in the CGP namespace, or does a future lock need an explicit source-qualified coordinate for private forks?
2. Which Node versions are the actual local catalog target, and does the supported runtime floor make a particular SQLite implementation practical?
3. Does CGP need concurrent access from a CLI and more than one running application process on the same machine in the first release?
4. Is a same-host database/store sufficient, or does the project have a concrete multi-host shared catalog requirement?
5. Which files are permitted in a v1 release package beyond the manifest, descriptor, one artifact, README, LICENSE, and safe assets?
6. Does the ASCII-only filename rule from Study 002 fit the actual module authoring community?
7. Which exact profile digest canonicalization implementation will be available in all supported runtimes?
8. Does project pin reconciliation happen on every locked compose, explicit install/update command, or a background/startup audit?
9. What process-identity mechanism can safely reclaim stale leases across supported Windows, macOS, and Linux targets?
10. What process-crash and power-loss durability guarantees can actually be tested and documented?
11. Is packageSetIdentity a standalone digest exposed in the runtime result, or a lock/diagnostic-only value initially?
12. Should the current fingerprint eventually be renamed to compositionStructureFingerprint, and how should old save documents be read?
13. Is source identity needed in the lock for the first local catalog, or is a packageTreeDigest plus local trusted source sufficient until there are conflicting sources?
14. What explicit retention policy does a user expect when a package is imported locally but not selected by any project lock?
15. What is the recovery policy for a lease whose process appears stale but cannot be proven dead?
16. Should a release revoked for security reasons remain usable from a pre-existing offline lock under an explicit owner override, or should revocation always block it?

Do not solve these by adding flags without a concrete workflow. Most do not block the first local package proof.

## 15. Research references

### CGP source documents

- [CGP Study 001 — Independent Module Package, Artifact, and SDK Contract](../cgp/001-independent-module-package-artifact-and-sdk-contract.md)
- [CGP Study 002 — Package Identity, Reproducible Archives, and Lock Semantics](../cgp/002-package-identity-reproducible-archives-and-lock-semantics.md)
- [CGP Study 003 — Local Catalog, Content Store, Leases, and Garbage Collection](../cgp/003-local-catalog-content-store-leases-and-garbage-collection.md)
- [Cross-Architecture Synthesis 001](001-cross-architecture-synthesis.md)
- [ADR 0007 — Public authoring surface](../../adr/0007-public-authoring.md)
- [ADR 0008 — Composition profiles](../../adr/0008-composition-profiles.md)
- [ADR 0010 — Execution boundary](../../adr/0010-execution-boundary.md)
- [ADR 0011 — Isolated WebAssembly guests](../../adr/0011-wasm-isolation.md)
- [ADR 0012 — Cross-backend execution and aggregate budgets](../../adr/0012-cross-backend-and-budgets.md)
- [ADR 0013 — Portable-module toolchain and licenses](../../adr/0013-authoring-toolchain-and-license.md)
- [ADR 0014 — Host accounting, log retention, and third-party guests](../../adr/0014-accounting-and-third-party-guests.md)

### External technical references

- [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html) — reader/writer concurrency, one-writer serialization, same-host constraint, and WAL checkpoint behavior.
- [SQLite — Isolation](https://sqlite.org/isolation.html) — committed-transaction visibility and serializable write behavior.
- [containerd — Garbage Collection](https://github.com/containerd/containerd/blob/main/docs/garbage-collection.md) — leases as explicit resource roots and caller-managed lifetime.
- [Node.js v26.13.1 — File System API](https://nodejs.org/api/fs.html) — rename overwrite behavior and OS/device-specific FileHandle.sync behavior.
- [TUF Specification 1.0.37](https://theupdateframework.github.io/specification/latest/) — signed metadata roles, threshold keys, snapshot consistency, freshness, rollback/freeze protection, and mirror roles.

## Conclusion

The three package studies describe a coherent direction once their identities and lifetimes are made explicit.

The released package is a content-addressed immutable object. The catalog maps release coordinates and trusted sources to that object. The profile states application intent; the lock identifies exact package content. The package manager verifies and leases those packages, then passes them to Foundations. Foundations continues to own composition and runtime lifecycle. The backend continues to own execution sessions and guest resources.

The principal corrections before implementation are to preserve the existing save-facing composition fingerprint, add a separate package-set identity, serialize every retention-root creation against GC, and define the local storage transaction and recovery boundary precisely.

The first implementation should prove one independently authored local package all the way through static validation, digest calculation, immutable storage, catalog registration, verification, and composition. Archives, remote catalogs, TUF, automatic GC, and multi-host storage can wait until the local workflow is reliable.

No implementation or accepted ADR changes are made by this review.