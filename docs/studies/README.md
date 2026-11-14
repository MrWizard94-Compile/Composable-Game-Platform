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

### wasmCloud

| Study | Subject | Status |
|---|---|---|
| [001 — Component host and capability model](wasmcloud/001-component-host-and-capability-model.md) | v2 host architecture, WIT contracts, host plugins, services, workload boundaries, and security model | Complete |
| [002 — Component Model and WIT](wasmcloud/002-component-model-and-wit.md) | Typed interfaces, worlds, Canonical ABI, versioning, resources, async/cancellation, Node/browser portability, and CGP mapping | Complete |

### Current ABI research direction

The wasmCloud studies support a WIT compatibility prototype before finalizing M4. This is not an ABI migration decision. CGP's manifests, nested Slot graph, profile resolution, authorization, deterministic mutation authority, and persistence remain CGP-owned. The prototype must compare the current core-module ABI with WIT/Component Model execution in Wasmtime, Node, and browser-transpiled environments.

### Explicitly requested future studies

These projects are queued for later comparative research:

| Project | Planned focus |
|---|---|
| **Extism 002** | Guest state/reset semantics, host capability security, failure recovery, browser/runtime parity, and resource enforcement |
| **OSGi** | Bundle lifecycle, service registry, dependency resolution, versioning, and dynamic modularity |

### Additional comparative subject

- **WebAssembly Component Model:** typed interfaces, component composition, and cross-language interoperability. The wasmCloud study identifies this as the next focused ABI investigation for CGP.

## CGP baselines

- O3DE studies 001 and 002 used CGP commit **37739db60e77e69369e002bfa5d54ce4159c2438** as their implementation comparison baseline.
- O3DE study 003 uses CGP commit **3ad9e3bb33e6b8bb046f8544523d21d0e96ee996** as its repository baseline. No CGP implementation changes occurred between these baselines; the intervening commits added studies documentation.
- wasmCloud study 001 uses CGP commit **e6128a26ea41d09dbabb64bb7f48a1eb127e274e** as its implementation comparison baseline.

Update baselines in later studies when the CGP architecture changes materially.

- Extism study 001 uses CGP commit **2777971d99b5dfaa26f2e7898ba6b11f471c99de** as its implementation comparison baseline.
