# Architectural Studies

This directory records comparative research intended to inform the design of Composable Game Platform (CGP).

These studies are **research notes, not implementation decisions**. A recommendation here does not authorize a code or architecture change. Before adopting an idea, compare it with the current CGP contracts, document trade-offs, and decide whether the capability is actually needed.

## Study method

Each study should record:

- The question being investigated and why it matters to CGP.
- The external project's documentation and source revision where practical.
- Observed behavior separately from interpretation and recommendations.
- Relevant differences from CGP, including features that should not be copied.
- Follow-up questions and unresolved uncertainties.

For source-level studies, prefer immutable commit links over links to a moving development branch. Re-check current upstream behavior before relying on an old study for implementation.

## Studies

### Open 3D Engine (O3DE)

| Study | Subject | Status |
|---|---|---|
| [001 — Gems, packaging, and distribution](o3de/001-gems-packaging-and-distribution.md) | Gem package model, manifests, compatibility, dependency resolution, and remote repositories | Complete |
| [002 — ModuleManager and native module lifecycle](o3de/002-module-manager-and-native-lifecycle.md) | Native library loading, staged initialization, ownership, component activation, and shutdown | Complete |
| [003 — System Component services and dependency ordering](o3de/003-system-component-services-and-dependency-ordering.md) | Provided, required, optional-dependent, and incompatible services; entity and system-component activation order | Complete |

### OSGi

| Study | Subject | Status |
|---|---|---|
| [001 — Bundle lifecycle, service registry, and dynamic modularity](osgi/001-bundle-lifecycle-services-and-dynamic-modularity.md) | Bundle identity and lifecycle, requirement-capability resolution, package wiring, dynamic services, Declarative Services, update/refresh, and isolation boundaries | Complete |
| [002 — Declarative Services, dynamic binding, and concurrency](osgi/002-declarative-services-dynamic-binding-and-concurrency.md) | Reference cardinality and policies, service scopes, component activation, concurrent rebinding, Felix SCR scheduling, and churn tests | Complete |
| [003 — Constraint resolution, class-space consistency, and revision refresh](osgi/003-constraint-resolution-class-space-consistency-and-revision-refresh.md) | Requirement/capability constraint solving, Java package uses constraints, resolver diagnostics, old revisions, removal-pending wiring, and dependent-closure refresh | Complete |

### Bevy

| Study | Subject | Status |
|---|---|---|
| [001 — Plugin architecture and application composition](bevy/001-plugin-architecture-and-application-composition.md) | Plugin lifecycle, plugin groups, compile-time feature modularity, App/SubApp composition, scheduling, and developer experience | Complete |
| [002 — Plugin dependencies, SubApps, and dynamic extensibility](bevy/002-plugin-dependencies-subapps-and-dynamic-extensibility.md) | Plugin dependency limits, ECS schedule graphs, SubApp world boundaries and extraction, removal semantics, and function hotpatching | Complete |
| [003 — ECS data ownership, scheduling guarantees, and state boundaries](bevy/003-ecs-data-ownership-scheduling-and-state-boundaries.md) | Typed access declarations, conflict detection, parallel execution, deferred commands, change detection, and deterministic-state implications | Complete |

### Extism

| Study | Subject | Status |
|---|---|---|
| [001 — Plugin host architecture, guest SDKs, and lifecycle](extism/001-plugin-host-architecture-and-lifecycle.md) | Embedded Wasm runtime, Host SDK/PDK split, byte ABI, host functions, manifests, state, limits, pools, and failure behavior | Complete |
| [002 — State persistence, failure recovery, and runtime security](extism/002-state-persistence-failure-recovery-and-runtime-security.md) | Reset semantics, guest state lifetime, unhealthy pool instances, HTTP allowlists and redirects, timeout boundaries, and CGP conformance tests | Complete |

### wasmCloud

| Study | Subject | Status |
|---|---|---|
| [001 — Component host and capability model](wasmcloud/001-component-host-and-capability-model.md) | v2 host architecture, WIT contracts, host plugins, services, workload boundaries, and security model | Complete |
| [002 — Component Model and WIT](wasmcloud/002-component-model-and-wit.md) | Typed interfaces, worlds, Canonical ABI, versioning, resources, async/cancellation, Node/browser portability, and CGP mapping | Complete |

### Current ABI research direction

The wasmCloud studies support a WIT compatibility prototype before finalizing M4. This is not an ABI migration decision. CGP's manifests, nested Slot graph, profile resolution, authorization, deterministic mutation authority, and persistence remain CGP-owned. The prototype must compare the current core-module ABI with WIT/Component Model execution in Wasmtime, Node, and browser-transpiled environments.

### Additional comparative subject

- **WebAssembly Component Model:** typed interfaces, component composition, and cross-language interoperability. The wasmCloud study identifies this as the next focused ABI investigation for CGP.

### Cross-architecture synthesis

| Synthesis | Subject | Status |
|---|---|---|
| [001 — Cross-architecture findings and design boundaries](synthesis/001-cross-architecture-synthesis.md) | Comparative findings across O3DE, Bevy, wasmCloud, Extism, and OSGi; CGP invariants, gaps, and research priorities | Complete |
| [002 — CGP package architecture review and implementation boundary](synthesis/002-cgp-package-architecture-review-and-implementation-boundary.md) | Cross-study reconciliation of CGP package Studies 001–003; ADR compatibility; package, save, and runtime identities; storage/lease/GC refinements; and first implementation milestone | Complete (proposed decisions; ADR review pending) |

### ADR proposals and decisions

| ADR | Subject | Status |
|---|---|---|
| [0017 — Independent module release package and identity](../adr/0017-independent-module-release-package-and-identity.md) | Accepted v1 package descriptor, JavaScript/Wasm release artifacts, portable path profile, canonical package-tree digest, and immutable module release coordinates | Accepted — implementation pending |
| [0018 — Local content store and release catalog](../adr/0018-local-content-store-and-release-catalog.md) | Content-addressed local objects and catalog registration outside Foundations. | Accepted |
| [0019 — Project lockfiles and exact local resolution](../adr/0019-project-lockfiles-and-exact-local-resolution.md) | Exact project pins. No dependency solving. | Accepted |
| [0020 — Cross-language modules](../adr/0020-cross-language-modules.md) | November 2026 top ten as documentation, not a Foundations export. Only JavaScript is hosted. A WebAssembly guest has no source language. | Accepted |

This table tracks both proposals and accepted decisions. Acceptance records the architecture contract; it does not imply that implementation or conformance tests are complete.

### CGP package and SDK design

| Study | Subject | Status |
|---|---|---|
| [001 — Independent module package, artifact, and SDK contract](cgp/001-independent-module-package-artifact-and-sdk-contract.md) | Proposed package format, JavaScript/Wasm artifacts, SDK boundaries, artifact digests, profile locks, local catalog, provenance, and validation security | Complete (proposed contract; ADR review pending) |
| [002 — Package identity, reproducible archives, and lock semantics](cgp/002-package-identity-reproducible-archives-and-lock-semantics.md) | Artifact, package-tree, and archive digests; deterministic package identity; lock semantics; immutable releases; and safe archive acquisition | Complete (proposed contract; ADR review pending) |
| [003 — Local catalog, content store, leases, and garbage collection](cgp/003-local-catalog-content-store-leases-and-garbage-collection.md) | Content-addressed local storage, transactional registration, concurrent access, project pins, active composition leases, recoverable GC, offline operation, and future mirror trust | Complete (proposed contract; ADR review pending) |
| [004 — Verified package installation and runtime activation](cgp/004-verified-package-installation-and-runtime-activation.md) | Separation of install, resolve, activate, publish, and deactivate; runtime trust, package leases, TOCTOU, transactional generations, and staged activation | Complete (proposed design; ADR review pending) |
| [005 — Wasm activation snapshot contract](cgp/005-wasm-activation-snapshot-contract.md) | Single-scan verified package snapshots, byte ownership, Wasm-only activation, snapshot retention versus runtime ownership, and conformance gates | Complete (proposed contract; ADR review pending) |
| [006 — Content-store reader coordination boundary](cgp/006-content-store-reader-coordination-boundary.md) | Cooperative cross-process reader/writer markers, snapshot-scoped Wasm reads, stale-marker failure policy, and prerequisites for safe garbage collection | Implemented |
| [007 — Persistent retention and GC preview](cgp/007-persistent-retention-and-gc-preview.md) | Persistent local-import and project-lock pins, object ready/deleting states, token-owned deletion claims, conservative legacy migration, and verified dry-run mark analysis | Implemented preview/claim slice |
| [008 — Recoverable destructive garbage collection](cgp/008-recoverable-destructive-garbage-collection.md) | Versioned lifecycle migration, quarantine tombstones, crash recovery, idle-claim reconcile, and explicit --apply deletion | Implemented |
| [009 — Composition leases](cgp/009-composition-leases.md) | A GC retention root for one live composition, released after shutdown, without holding a store reader | Implemented |
| [010 — Unified project activation](cgp/010-unified-project-activation.md) | Node activation of JavaScript, Wasm, and mixed locks on the existing backends, after one verification lease | Implemented |
| [011 — Package resource access and ownership](cgp/011-package-resource-access-and-ownership.md) | Opaque per-package view of verified file bytes for opted-in JavaScript where cleanup can pin the activation directory. No store path, Wasm import, or new digest | Implemented JavaScript slice |
| [012 — Wasm package resource ABI and memory ownership](cgp/012-wasm-package-resource-abi.md) | One synchronous `cgp.abi.resource_read` into guest memory. The isolate packs one package, transfers it, and copies by status code. Node project activation attaches that guest's verified pack when the binary imports `resource_read`. Browser stored-project activation does not | Phase 4 activation |
| [013 — WIT compatibility prototype](cgp/013-wit-compatibility-prototype.md) | One sync WIT slot contract, Rust and JavaScript guests, Wasmtime plus jco on Node 22 and Chromium. Not a replacement for `cgp.abi/1` | Prototype only |
| [014 — Deterministic simulation, state authority, and replay](cgp/014-deterministic-simulation-state-authority-and-replay.md) | What the integer simulation proof guarantees, what it does not, and which replay boundaries belong outside Foundations | Research only |

Study 001 recommends a local package/lock workflow before a public registry. Study 002 defines a proposed canonical package-tree identity independent of archive transport. Study 003 defines a proposed local catalog and content lifecycle outside Foundations. Study 006 establishes the reader-coordination boundary. Study 007 implements persistent retention roots, object states, deletion claims, and a verified dry-run collector. Study 008 adds recoverable destructive deletion on that lifecycle: quarantine tombstones, explicit `--apply`, and token-owned deletion claims. Study 009 adds a composition lease so that deletion cannot quarantine bytes a live session still depends on. The lease is not a held reader marker. Study 010 uses that lease for JavaScript, Wasm, and mixed Node activation. JavaScript stays trusted in-process. Study 011 gives opted-in JavaScript an opaque view of its own verified package files. That view is not a Wasm import, not a browser loader, and not a new package identity. Study 012 specifies the Wasm import `cgp.abi.resource_read`, granted only by `cgp.resource.read` on both the manifest and the policy. The isolate packs that guest's files into one exact `ArrayBuffer`, transfers it, and copies into guest memory by status code. A missing pack is refused before instantiation. Node project activation attaches that guest's own verified files when the binary imports `cgp.abi.resource_read`, and passes the activation-wide snapshot budget. A guest that does not import it does not keep the extra file buffers. Browser stored-project activation does not attach a pack. The chosen delivery remains one exact packed `ArrayBuffer` per guest, transferred, not a structured clone of the scanner's pooled `Buffer`s. The index is an array of `{ path, offset, length }` records; the worker builds a `Map` from explicit pairs and rejects a malformed index before instantiation. Resource-pack accounting is per activation. Study 013 is a separate WIT prototype under `prototypes/wit-013`. It does not change `cgp.abi/1`, package identity, or activation. Study 014 reads the accepted simulation proof and does not change it. The integer ledger, the caller-driven step, and the absence of a replay log are described there. These studies do not change accepted package or lock schemas.

## CGP baselines

- O3DE studies 001 and 002 used CGP commit **37739db60e77e69369e002bfa5d54ce4159c2438** as their implementation comparison baseline.
- O3DE study 003 uses CGP commit **3ad9e3bb33e6b8bb046f8544523d21d0e96ee996** as its repository baseline. No CGP implementation changes occurred between these baselines; the intervening commits added studies documentation.
- wasmCloud study 001 uses CGP commit **e6128a26ea41d09dbabb64bb7f48a1eb127e274e** as its implementation comparison baseline.

Update baselines in later studies when the CGP architecture changes materially.

- Extism study 001 uses CGP commit **2777971d99b5dfaa26f2e7898ba6b11f471c99de** as its implementation comparison baseline.
- OSGi study 001 uses CGP commit **37e3191f268d281a4163107f5e5d2498d4a77fa8** as its implementation comparison baseline.
- OSGi study 003 uses CGP commit **d24266e79a91036f0e08b66c2a3040f0326d6dbb** as its implementation comparison baseline. The commits since OSGi study 001 changed research documentation only; no CGP implementation code changed.
- Cross-architecture synthesis 001 uses CGP commit **4b87d37084a7c5b30fa642763edc5e497452d6d3** as its repository baseline. It synthesizes the 13 completed comparative studies and does not change CGP implementation or ADRs.
- CGP study 014 uses commit **f85ccbbea2b7a2872dce2b1abf17781438f75560** as its repository baseline. It is research only. No simulation code, ADR, or package schema changed.
