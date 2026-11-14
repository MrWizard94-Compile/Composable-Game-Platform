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

### Planned comparative subjects

- wasmCloud: component host, capability providers, and operational boundaries.
- WebAssembly Component Model: typed interfaces, composition, and cross-language interoperability.
- Bevy: plugin-oriented game architecture and developer experience.
- OSGi: modular runtime services, bundle lifecycle, and versioned dependencies.
- Extism: embedded WebAssembly plugin hosting.

## CGP baseline

The first O3DE studies use CGP commit **37739db60e77e69369e002bfa5d54ce4159c2438** as the comparison baseline. Update the baseline in later studies when the CGP architecture changes materially.
