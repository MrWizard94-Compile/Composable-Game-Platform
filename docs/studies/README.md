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

The synthesis recommends **CGP Study 001 — Independent Module Package, Artifact, and SDK Contract** as the next focused research slice. This is a research priority, not an approved implementation change.

### CGP package and SDK design

| Study | Subject | Status |
|---|---|---|
| [001 — Independent module package, artifact, and SDK contract](cgp/001-independent-module-package-artifact-and-sdk-contract.md) | Proposed package format, JavaScript/Wasm artifacts, SDK boundaries, artifact digests, profile locks, local catalog, provenance, and validation security | Complete (proposed contract; ADR review pending) |
| [002 — Package identity, reproducible archives, and lock semantics](cgp/002-package-identity-reproducible-archives-and-lock-semantics.md) | Artifact, package-tree, and archive digests; deterministic package identity; lock semantics; immutable releases; and safe archive acquisition | Complete (proposed contract; ADR review pending) |

Study 001 recommends a local package/lock workflow before a public registry. Study 002 recommends defining a canonical package directory and package-tree digest before selecting an archive transport. Neither study changes accepted ADRs or implementation.

## CGP baselines

- O3DE studies 001 and 002 used CGP commit **37739db60e77e69369e002bfa5d54ce4159c2438** as their implementation comparison baseline.
- O3DE study 003 uses CGP commit **3ad9e3bb33e6b8bb046f8544523d21d0e96ee996** as its repository baseline. No CGP implementation changes occurred between these baselines; the intervening commits added studies documentation.
- wasmCloud study 001 uses CGP commit **e6128a26ea41d09dbabb64bb7f48a1eb127e274e** as its implementation comparison baseline.

Update baselines in later studies when the CGP architecture changes materially.

- Extism study 001 uses CGP commit **2777971d99b5dfaa26f2e7898ba6b11f471c99de** as its implementation comparison baseline.
- OSGi study 001 uses CGP commit **37e3191f268d281a4163107f5e5d2498d4a77fa8** as its implementation comparison baseline.
- OSGi study 003 uses CGP commit **d24266e79a91036f0e08b66c2a3040f0326d6dbb** as its implementation comparison baseline. The commits since OSGi study 001 changed research documentation only; no CGP implementation code changed.
- Cross-architecture synthesis 001 uses CGP commit **4b87d37084a7c5b30fa642763edc5e497452d6d3** as its repository baseline. It synthesizes the 13 completed comparative studies and does not change CGP implementation or ADRs.
