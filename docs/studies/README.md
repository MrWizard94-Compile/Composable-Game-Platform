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

### Explicitly requested future studies

These projects are queued for later comparative research:

| Project | Planned focus |
|---|---|
| **Bevy** | Plugin architecture, modular engine features, application composition, and developer experience |
| **wasmCloud** | WebAssembly component hosting, capability providers, interfaces, and runtime boundaries |
| **Extism** | Embedded WebAssembly plugin hosting, host/guest SDKs, and plugin lifecycle |
| **OSGi** | Bundle lifecycle, service registry, dependency resolution, versioning, and dynamic modularity |

### Additional comparative subject

- **WebAssembly Component Model:** typed interfaces, component composition, and cross-language interoperability.

## CGP baselines

- O3DE studies 001 and 002 used CGP commit **37739db60e77e69369e002bfa5d54ce4159c2438** as their implementation comparison baseline.
- O3DE study 003 uses CGP commit **3ad9e3bb33e6b8bb046f8544523d21d0e96ee996** as its repository baseline. No CGP implementation changes occurred between these baselines; the intervening commits added studies documentation.

Update baselines in later studies when the CGP architecture changes materially.
