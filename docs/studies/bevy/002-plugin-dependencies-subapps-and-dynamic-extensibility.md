# Bevy Study 002 — Plugin Dependencies, SubApps, and Dynamic Extensibility

**Research date:** 2026-11-14  
**External project:** Bevy  
**Upstream source revision inspected:** [7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a) (workspace version 0.20.0-dev)  
**CGP comparison baseline:** [89e5a9245c564aa7c16b4dd651a9efab29f3c9a6](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/89e5a9245c564aa7c16b4dd651a9efab29f3c9a6)

## Purpose

Investigate three questions left open by Bevy Study 001:

1. How does Bevy express plugin dependencies and setup prerequisites?
2. What boundaries do SubApps provide, and how do they communicate?
3. Does Bevy hotpatching provide runtime module replacement comparable to CGP's independently packaged modules?

This remains comparative research. It is not an implementation decision and does not authorize a CGP architecture change or a Bevy dependency.

## Executive findings

1. **Bevy Plugin has no declarative package dependency contract.** The Plugin trait exposes build, ready, finish, cleanup, name, and uniqueness. It does not declare required plugin IDs, version ranges, optional dependencies, or capabilities. Plugin authors and application builders coordinate ordering through code and PluginGroups.
2. **Bevy's ECS scheduler does have a real dependency graph—but it is a different graph.** Systems and system sets declare before/after constraints. Schedule construction detects cycles and incompatible set relationships and can report access ambiguities. This graph orders systems inside a schedule; it does not resolve plugin packages or ensure that an external plugin dependency is installed.
3. **SubApps own separate ECS Worlds and schedules.** They can be updated independently and can exchange selected data through a host-provided extraction callback. This is useful for separating application domains such as rendering, but it is not a security sandbox or a general module ownership model.
4. **SubApp removal is container removal, not a full module unload protocol.** The App API removes a labeled SubApp and returns it. The removal method itself does not run a dedicated stop/unload hook for every plugin or reverse external side effects.
5. **Bevy hotpatching replaces function implementations in a running process.** The inspected development implementation connects to Dioxus CLI/Subsecond jump-table updates and refreshes hotpatchable systems/functions. It does not discover, resolve, load, isolate, or unload independent plugin packages.
6. **CGP should keep its separate graphs and boundaries.** Package/module dependencies, nested Slot ownership, execution ordering, and system-internal scheduling are distinct concerns. Bevy reinforces that they should not be conflated.

## 1. Version and evidence boundary

This study pins Bevy source revision `7ea4827e16d5d50d48e22d9a249c554ad073f38a`, whose workspace reports `0.20.0-dev`. The moving main branch is not treated as a stable reference.

The conclusions below are source-level observations at that revision. Some public documentation links resolve to published releases, so pinned source is preferred for exact API claims.

Primary source files:
- [Plugin trait](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin.rs)
- [App](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/app.rs)
- [SubApp](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/sub_app.rs)
- [PluginGroupBuilder](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin_group.rs)
- [Schedule graph and build logic](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/schedule.rs)
- [Hotpatch implementation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/hotpatch.rs)
- [Hotpatching systems example](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/examples/ecs/hotpatching_systems.rs)
- [Workspace feature declarations](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/Cargo.toml)

## 2. Plugin dependencies: what exists and what does not

### 2.1 The Plugin trait does not declare dependencies

At the inspected revision, the Plugin trait's public lifecycle contract consists of:

- `build(&self, app: &mut App)`
- `ready(&self, app: &App) -> bool`
- `finish(&self, app: &mut App)`
- `cleanup(&self, app: &mut App)`
- `name(&self) -> &str`
- `is_unique(&self) -> bool`

There is no trait method or associated manifest for:
- required plugin names or stable package IDs;
- minimum/maximum compatible plugin versions;
- optional dependencies;
- capability requirements;
- dependency conflict declarations;
- dependency graph resolution.

The App does expose `is_plugin_added<T>()` and `get_added_plugins<T>()`. A plugin can inspect whether a Rust plugin type is already present, but that is a runtime query against the current App, not a declared requirement that the host resolves before plugin code executes.

PluginGroups provide curated composition order. Their builder can insert plugins before or after another plugin type, disable a known member, and replace a configured instance. That order is authored by the group/application builder; it is not derived from semantic-versioned package requirements.

### 2.2 Where dependencies are handled instead

Bevy's plugin ecosystem relies on several complementary conventions:

1. **Cargo dependencies and features** ensure required crates are available in the compiled application.
2. **PluginGroups** provide conventional bundles and explicit installation order.
3. **Plugin build code** registers the resources, schedules, types, and other services the plugin needs.
4. **App introspection** allows code to check for known plugin types.
5. **ECS system parameters and runtime access** enforce or detect certain resource/component access constraints when systems are initialized and run.
6. **Schedule dependency constraints** order systems and sets within a schedule.

These mechanisms solve different parts of the problem. Cargo can make a dependency available at compile time without ensuring a corresponding Plugin was added to a particular App. Plugin ordering can ensure one plugin builds before another, but does not provide a general compatibility resolver. ECS schedule ordering can order systems after a set, but does not prove that the provider plugin was installed.

### 2.3 Implication for CGP

CGP already treats dependencies as manifest-level constraints and capability requirements, with optional requirements, explicit provider pins, ambiguity refusal, and cycle detection.

That is stronger and more appropriate for independently distributed packages. Bevy's approach is acceptable for a trusted, statically compiled Rust application where the application author controls the plugin set.

Do not weaken CGP's package resolver to imitate Bevy's conventions. If CGP later adds authoring convenience presets, they should generate or select valid manifests/profiles and then pass through the same resolver.

## 3. Bevy's system dependency graph is not a plugin dependency graph

Bevy's ECS scheduler models ordering constraints between systems and system sets. A dependency edge represents a before/after relationship. Dependencies can be strict or weak; weak dependencies permit parallel execution when there is no conflicting access.

During schedule construction, Bevy analyzes:
- system-set hierarchy;
- ordering dependency cycles;
- cross-dependencies between hierarchy and ordering;
- overlapping system groups that cannot be ordered;
- ambiguous system-type-set references;
- system access conflicts and scheduling ambiguities.

Schedule building can return structured errors for invalid graph relationships. Ambiguities can be reported as warnings or errors according to schedule settings.

This is a genuine dependency graph, but its nodes are schedule systems/system sets, not packages. It answers: "When can these systems execute relative to one another?" It does not answer: "Which independently distributed package satisfies this module's contract requirement?"

### CGP mapping

CGP has at least three graph-like structures that should remain distinct:

| Graph | Nodes and edges | Primary question |
|---|---|---|
| Package/composition graph | Modules and declared dependencies | Is the package set valid, and in what lifecycle order should modules initialize? |
| Slot contribution graph | Module-owned Slots and contributions | Which modules contribute to which contracts, with what multiplicity and ordering? |
| Runtime execution graph | Systems, calls, or proposals within a simulation step | What runs in what order, and when may authoritative state change? |

Bevy's ECS schedule graph is most analogous to CGP's runtime execution graph, not to CGP's package resolver or Slot ownership graph.

A particularly useful lesson is that a scheduler can be sophisticated without becoming a package manager. CGP should not attempt to use one generic dependency graph to solve all three problems.

## 4. SubApps: separate worlds with explicit data extraction

A SubApp owns:
- its own ECS World;
- its own plugin registry and plugin-name set;
- its own plugin-build depth and plugin lifecycle state;
- its own optional default update schedule;
- an optional extraction callback.

A SubApp's World is not the same object as the main App's World. A SubApp can register its own plugins and systems. It can run its own configured schedule when updated.

The extraction callback is explicitly configured by the application/plugin author. It receives mutable access to both the main World and the SubApp World and is intended primarily for copying selected data from the main application domain into the secondary one.

There is no default extraction function. If none is installed, calling extract does nothing. The callback can be taken, wrapped, and reinstalled—for example, to add custom work before and after Bevy's renderer extraction phase.

The rendering architecture uses this separation to maintain render-specific state and work separately from the main application world. It is an architectural boundary for data organization and execution, not a sandbox boundary.

### 4.1 What SubApps are good at

- Separating subsystems that have distinct data models and schedules.
- Avoiding one giant shared ECS World for every application concern.
- Defining a controlled data-transfer point between application domains.
- Updating a secondary application domain as part of a larger application.
- Keeping render-specific data and execution out of the main gameplay World.

### 4.2 What SubApps do not provide

- Process or memory isolation.
- A security boundary against arbitrary Rust code.
- A declarative cross-world contract or schema negotiation system.
- Automatic copying, synchronization, or conflict resolution.
- Package version resolution.
- A universal module unload protocol.
- Automatic deterministic ordering of all application work.

The extraction callback itself is trusted in-process code with mutable access to both worlds. It is a deliberate bridge, not a capability-secure membrane.

### 4.3 Removal behavior and lifecycle caveat

The App exposes `remove_sub_app(label)`, which removes the labeled SubApp from the internal map and returns the removed SubApp value.

The method body does not itself invoke a distinct per-plugin stop/unload lifecycle or reverse the side effects of plugins that were installed into that SubApp. The caller receives the removed object and can decide what to do with it, but the removal API is not a complete unload protocol.

This distinction matters: **removing a container from an App is not equivalent to safely unloading every extension that contributed to it.** Resource handles, background tasks, threads, callbacks, external registrations, and references held elsewhere may outlive the container unless the owning application coordinates their shutdown.

### CGP mapping

Nested module-owned Slots are not equivalent to SubApps. A Slot is an ownership and contribution boundary inside CGP's composition graph. A SubApp is a secondary ECS application domain with its own World and schedule.

The useful analogy is narrower: a module-owned domain can expose an explicit bridge for data exchange rather than sharing all internal state. CGP's contract and host authority should define the bridge, not a raw callback with arbitrary access to both domains.

## 5. Hotpatching: code replacement, not module lifecycle

The inspected Bevy hotpatch implementation is enabled through the `hotpatching` Cargo feature. The `HotPatchPlugin` connects to Dioxus CLI/Subsecond, receives notifications when jump tables are updated, and signals the ECS that hotpatchable functions have changed.

The example is run through:

~~~sh
dx serve --hot-patch --example hotpatching_systems --features hotpatching
~~~

The example demonstrates changing the body of an ECS system and an observer while the application remains running. It also demonstrates wrapping a function with Bevy's hotpatch call helper so that a selected function can be patched when invoked from a thread.

At the ECS level, systems refresh their hotpatch implementation when the hotpatch change marker is newer than their last run. The mechanism refreshes code targets for registered systems/functions.

### What it does not do

The mechanism does not:
- discover new plugin packages;
- load an independent plugin artifact from a registry;
- validate a package manifest or semantic version;
- resolve package dependencies or Slot providers;
- create a new isolated execution instance;
- grant/revoke module capabilities;
- migrate module-owned persistent state;
- run a module shutdown protocol;
- unload code and all resources associated with a module.

This is a developer iteration feature for patching function implementations in a running process. It should not be described as runtime plugin loading or module hot reload.

### CGP mapping

CGP's future hot replacement problem is much larger than replacing a function pointer. It must define at least:

1. How a replacement package is identified and validated.
2. Whether its manifest and contracts remain compatible.
3. How active dispatch is quiesced.
4. What happens to in-flight service calls and asynchronous work.
5. How old module-owned resources and Slot contributions are detached.
6. Whether state is migrated, restored, reset, or rejected.
7. How the replacement is registered and initialized.
8. What happens if the new module fails after the old one is stopped.
9. How rollback works and what state is authoritative during transition.
10. How replay and deterministic simulation treat the transition boundary.

Bevy's hotpatching is not a model for these lifecycle semantics. It does show that development-time function patching can be a separate tool from production module packaging, which is worth preserving as a conceptual distinction.

## 6. Comparison with CGP

| Concern | Bevy | CGP |
|---|---|---|
| Plugin dependencies | No general declarative dependency manifest on Plugin | Manifest-declared capability/module requirements and resolution |
| Dependency ordering | PluginGroup installation order; system/set schedule graph | Topological package lifecycle order plus explicit contribution order |
| Version compatibility | Primarily Cargo dependency resolution at build time | Runtime manifest/API compatibility and pinned package profiles |
| Setup readiness | Plugin ready/finish phases | Explicit lifecycle; backend/service readiness may be a future extension if justified |
| Application domains | SubApps with separate ECS Worlds | Modules own private state and nested Slots; host mediates contracts |
| Cross-domain exchange | Author-defined extraction callback with mutable access to both Worlds | Host-defined contracts and explicit module/Slot dispatch |
| Isolation | In-process Rust; SubApp is not a sandbox | Backend-enforced WebAssembly isolation; trusted in-process JS is explicitly not sandboxed |
| Removal | SubApp container can be removed; not a universal plugin unload | Composition shutdown exists; dynamic replacement remains a separate future design problem |
| Hotpatch | Replaces function implementations in a running process | No equivalent independent-package hot replacement contract yet |
| Persistence migration | Not solved by hotpatch mechanism | Module-owned save slices exist; migration across replacement versions needs explicit policy |

## 7. Recommendations for CGP

### Keep

1. **Keep package dependency resolution manifest-driven.** Bevy's type-based presence checks are not a substitute for CGP's package identity, version, optionality, ambiguity, and cycle rules.
2. **Keep Slot ownership separate from execution ordering.** The system schedule graph and the package graph solve different problems.
3. **Keep cross-module communication contract-based.** Avoid giving one module arbitrary mutable access to another module's private state.
4. **Treat container removal and module unload as separate operations.** Any future unload must account for calls, resources, background work, save state, and reverse cleanup.
5. **Keep development hotpatch separate from production package replacement.** Function patching can improve iteration without implying a safe module update protocol.

### Consider later, only if justified

1. **A separate domain/worker abstraction:** if CGP gains a need to host subsystems with distinct execution schedules and explicit data transfer, study whether this belongs in a backend or a higher-level runner—not in the Foundations.
2. **Lifecycle readiness:** an asynchronous ready phase may become useful for host-managed services or backend initialization. It should not be introduced merely because Bevy has it.
3. **Development-only hotpatching:** a future authoring tool could support function-level iteration, but must not weaken production module validation or imply that code replacement is a supported package lifecycle.

### Do not copy

- Do not rely on runtime type checks as the primary dependency contract.
- Do not conflate ECS system ordering with module dependency resolution.
- Do not treat a SubApp as a sandbox or a CGP Slot.
- Do not treat `remove_sub_app` as proof of safe plugin unloading.
- Do not label function hotpatching as dynamic module loading.
- Do not add ECS or renderer concepts to the CGP Foundations.

## 8. Open questions

- Which CGP lifecycle operations must become asynchronous when a backend or service has real startup latency?
- Does CGP need a formal quiesce phase before shutdown or future replacement?
- What contract should govern outstanding service calls when a composition is shutting down?
- Would a future execution-domain abstraction improve CGP, or would it simply duplicate backend isolation and nested Slot ownership?
- What state migration guarantees are realistic for independently authored modules?
- Should development-time hotpatching be considered independently from production package update support?

## Sources

### Pinned Bevy source

- [Bevy source revision 7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a)
- [Plugin trait](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin.rs)
- [App plugin registration and SubApp APIs](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/app.rs)
- [SubApp worlds, extraction, and lifecycle](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/sub_app.rs)
- [PluginGroupBuilder](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin_group.rs)
- [Schedule graph construction and validation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/schedule.rs)
- [Hotpatch plugin](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/hotpatch.rs)
- [Hotpatching systems example](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/examples/ecs/hotpatching_systems.rs)
- [Cargo feature declarations](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/Cargo.toml)

### CGP comparison baseline

- [CGP commit 89e5a9245c564aa7c16b4dd651a9efab29f3c9a6](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/89e5a9245c564aa7c16b4dd651a9efab29f3c9a6)
- [ADR 0002 — Manifests, Slots, and Resolution](../../adr/0002-manifest-slots-and-resolution.md)
- [ADR 0003 — Execution, Trust, and Lifecycle](../../adr/0003-execution-trust-and-lifecycle.md)
- [ADR 0015 — Caller-Driven Simulation Steps](../../adr/0015-deterministic-steps.md)
