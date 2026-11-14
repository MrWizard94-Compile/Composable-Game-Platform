# Bevy Study 001 — Plugin Architecture and Application Composition

**Research date:** 2026-11-14  
**External project:** Bevy  
**Upstream source revision inspected:** [7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a) (main; workspace version 0.20.0-dev)  
**CGP comparison baseline:** [24d9c3dacb23b54598d317540fc71c66f9131c80](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/24d9c3dacb23b54598d317540fc71c66f9131c80)

## Purpose

Study how Bevy organizes application capabilities through plugins, plugin groups, application state, schedules, and compile-time feature selection. Identify transferable composition and developer-experience ideas without confusing an in-process Rust game-engine extension mechanism with CGP's independently packaged module host.

This is a research note, not an implementation decision. It does not authorize adding Bevy as a CGP dependency or changing CGP's module, Slot, execution, or scheduling contracts.

## Executive findings

1. **Bevy's Plugin is an application configurator, not a general external module format.** A plugin receives mutable access to an App and registers resources, systems, schedules, types, and other application configuration. Its build method executes inside the host process with host privileges.
2. **Plugin groups are curated, ordered bundles.** They can be nested, feature-gated, reordered, disabled, and have plugin instances replaced before installation. They are useful for composing built-in subsystems, but are not a package resolver or runtime dependency graph.
3. **Plugin lifecycle has distinct setup phases.** Build occurs immediately at registration; readiness can be polled; finish runs after registered plugins are ready; cleanup runs before schedules begin. These phases coordinate initialization, not general runtime unload or fault isolation.
4. **Bevy has two different modularity mechanisms.** Rust crates and Cargo features decide what is compiled and linked. Plugins decide what is configured in a particular App. One does not replace the other.
5. **Bevy's scheduler is parallel and not deterministic by default.** Explicit ordering constrains systems, but CGP's caller-driven, transactional simulation semantics require stronger guarantees than a general-purpose ECS schedule provides.
6. **The best CGP lessons are narrow:** reusable subsystem presets, lifecycle readiness, separation of build-time and composition-time modularity, and approachable authoring ergonomics. CGP should retain manifest-driven package identity, nested Slot ownership, explicit dependency resolution, isolation, and deterministic mutation authority.

## 1. Version and evidence boundary

Bevy's main branch at the inspected revision identifies the workspace as 0.20.0-dev. This study pins the source revision rather than treating the moving main branch as a permanent reference.

The upstream Cargo feature guide contains an example using Bevy 0.18 even though the inspected workspace is on the 0.20 development line. The feature model and declarations were therefore checked against the pinned repository Cargo files, not inferred from the version in that example. Published docs.rs pages are explanatory references and may resolve to a published version different from the inspected development snapshot.

Primary source files:
- [Plugin trait](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin.rs)
- [Plugin group implementation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin_group.rs)
- [App implementation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/app.rs)
- [SubApp implementation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/sub_app.rs)
- [Cargo feature declarations](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/Cargo.toml)
- [Cargo feature guide](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/docs/cargo_features.md)

## 2. What a Bevy Plugin actually is

The required Plugin method is:

~~~rust
fn build(&self, app: &mut App);
~~~

A plugin can register systems into schedules, insert resources, configure system sets, register reflected types, add other plugins, and configure application behavior. A plain function taking a mutable App reference can also implement the Plugin interface.

This is a low-friction authoring model: a subsystem author writes a small Rust type or function and uses the same App builder API available to the application itself.

Important consequences:

- The plugin is compiled as Rust code and linked into the application.
- Build receives mutable access to the App, so the plugin is trusted code with broad configuration authority.
- The trait requires Send, Sync, and Any, and supports dynamic dispatch inside the Rust process.
- Plugin identity is based on name(); the default name is the Rust type name.
- A plugin is unique by default. It may opt out of uniqueness with is_unique() returning false.
- The App records plugin instances and names for duplicate detection and introspection.

The abstraction does not define a portable artifact, manifest, dependency range, capability grant, sandbox, independent package resolver, or cross-language ABI.

**CGP distinction:** CGP's module manifest and ABI describe independently packaged code that the Foundation can discover, validate, resolve, and execute through an explicit backend. Bevy's Plugin is closer to a trusted host extension API or a package's in-process integration adapter than to a CGP portable module.

## 3. Plugin lifecycle: build, ready, finish, cleanup

The inspected Plugin trait defines four lifecycle methods:

| Phase | Trigger and purpose |
|---|---|
| build | Runs immediately when the plugin is added. Registers application configuration. |
| ready | Queried while plugins are being added/initialized. Defaults to true; can wait for asynchronous setup such as renderer initialization. |
| finish | Runs after all registered plugins report ready. Supports setup that depends on another plugin's asynchronous initialization. |
| cleanup | Runs after build and finish, before App schedules execute. Can release temporary setup resources or transfer data to another thread. |

The App exposes a plugin state progression: Adding → Ready → Finished → Cleaned. Its runner checks plugin readiness, then calls finish and cleanup. The App rejects adding plugins after finish or cleanup, and prevents updates while a plugin is actively building.

**Cleanup is not a general shutdown or unload callback.** It is the final setup phase before application schedules run. The Plugin trait does not provide a symmetric runtime stop/unload lifecycle for removing an installed plugin from a live App.

### Registration and failure behavior

The App reserves a registry position before invoking a plugin's build method. This preserves insertion order when a plugin adds nested plugins during its own build. It tracks plugin build depth so an App update or run cannot occur while plugin registration is in progress.

Duplicate unique plugins are rejected. The public add_plugins API documents a panic when a plugin has already been added. This is a developer-facing configuration error rather than a recoverable package-resolution result.

The inspected source catches a panic from build when the standard library feature is enabled, updates internal bookkeeping, and resumes the unwind. This is not plugin fault containment: a panic still propagates through application setup.

### CGP comparison

CGP's lifecycle is more explicit and failure-oriented:

- Discovery and validation happen before execution.
- Composition resolution determines a valid graph before registration.
- Registration collects contributions; initialization occurs in dependency order.
- Initialization failures trigger reverse-order cleanup of modules whose initialization was entered.
- Runtime execution is mediated by the host/backend, and shutdown is explicit.

Bevy's staged setup is a useful reference for dependencies that become ready asynchronously. Its broad mutable App access, panic-oriented duplicate errors, and lack of a plugin unload contract should not be copied as CGP's external module lifecycle.

## 4. Plugin groups: curated application presets

A PluginGroup combines several plugins into one installable unit. It builds a PluginGroupBuilder, which stores plugin entries and an explicit order.

The builder supports:
- Adding plugins and nested plugin groups.
- Reordering entries with before/after operations.
- Disabling or re-enabling a plugin while retaining its position.
- Replacing the configured instance of an existing plugin type.
- Checking whether a plugin exists or is enabled.
- Adding function-based plugins.
- Installing enabled plugins into an App in the builder's specified order.

The plugin_group! macro can generate documented groups, including nested groups and feature-gated members. This helps maintain readable subsystem presets without requiring each application to manually list every low-level plugin.

However, the group builder is not a general dependency solver:

- Entries are identified primarily by Rust TypeId within the group.
- Order is curated by the group author or application builder.
- Adding an already-present type replaces/repositions its entry rather than resolving package versions.
- Disabling is a pre-installation configuration action, not runtime unload.
- A missing target for strict before/after insertion is an error/panic path.
- At installation, a duplicate unique plugin already present in the App causes a panic.

**Transferable idea:** CGP may eventually benefit from named, reusable composition presets or authoring profiles that assemble a known set of modules and contributions. Such presets should still resolve through CGP's manifest and Slot rules and fail with structured diagnostics. A Bevy-style ordered list must not bypass CGP's dependency graph or deterministic contribution ordering.

## 5. Two layers of Bevy modularity

Bevy's modularity operates at two different timescales.

### 5.1 Crates and Cargo features: compile-time selection

The repository is split into Rust crates, including foundational application and ECS crates and optional engine subsystems. The top-level Bevy crate exposes features that compose these crates into application profiles.

The feature guide distinguishes:

- **Profiles:** high-level presets such as 2D, 3D, and UI.
- **Collections:** mid-level sets used to assemble custom profiles, such as default_app, default_platform, common_api, 2d_api, and 3d_api.
- **Individual features:** specific capabilities such as asset loading, audio, rendering, image formats, windowing, picking, and developer tools.

Applications can disable default features and select only the needed feature profile. The stated benefits are fewer dependencies, smaller binaries, and shorter compile times. The source also provides headless-oriented and no_std-oriented feature collections.

This is compile-time modularity. It controls what exists in the built application; it does not let an end user install a new arbitrary plugin package into an already-built executable.

The dynamic_linking feature is documented as improving iterative compile times. It should not be mistaken for a general runtime plugin marketplace or a sandboxed dynamic module loader.

### 5.2 Plugins: per-App runtime configuration

Once compiled, the application selects which plugins and plugin groups to add to a particular App. These plugins configure the App's resources, schedules, systems, and behavior.

| Concern | Mechanism |
|---|---|
| Whether a subsystem is compiled into the executable | Cargo crate dependencies and features |
| Whether a compiled subsystem is configured in this App | Plugin registration |
| A named bundle of compiled subsystems | PluginGroup |
| Runtime execution ordering of systems | ECS Schedule and system-set constraints |
| Independent external package discovery and compatibility | Not supplied by PluginGroup |

This separation is one of Bevy's strongest architectural lessons: build-time capability selection and application-level configuration are distinct concerns.

## 6. Application composition and the scheduler

Bevy's App owns an ECS World and schedule collection, and can contain SubApps with their own worlds, plugin registries, schedules, and optional data-extraction paths. This allows separate application domains, such as rendering, to maintain their own world and execution schedule while participating in a larger application.

The App is configured by plugins, then driven by a runner. The runner is responsible for repeatedly calling App::update when a loop is desired. The App API also permits headless and manually updated applications.

Bevy ECS schedules are designed for parallel execution. Systems with compatible data access can run concurrently. Explicit dependencies and SystemSets constrain ordering where necessary. The schedule API includes strict ordering, weak ordering, chaining, run conditions, and deferred-command synchronization.

Important caveats:

- The default execution order of independent systems is not deterministic.
- Conflicting systems without explicit ordering produce ambiguity diagnostics.
- An after/before constraint does not automatically add the referenced system to the schedule.
- Ordering across different schedules is ignored.
- Strict ordering can introduce synchronization points for deferred effects such as Commands.
- The scheduler cannot infer dependencies hidden behind interior mutability or other untracked side effects.

This is a good general-purpose engine scheduler, but it is not the same contract as CGP's deterministic simulation runner. CGP currently requires a caller-supplied integer step, explicit input snapshot, proposal pipeline, validation, and authoritative commit. A Bevy-style parallel schedule could be useful for non-authoritative tooling or presentation work, but should not mutate CGP's authoritative simulation state outside its commit lane.

## 7. Developer experience observations

Bevy's plugin model is approachable because the common path is small:

1. Create a plugin type or function.
2. Register systems/resources in build.
3. Add the plugin or a plugin group to the App.
4. Use SystemSets and explicit ordering where required.

The advanced path remains within the same model: plugin configuration can be parameterized, groups can be customized, and setup can wait for asynchronous readiness.

The source also supports introspection of registered plugins and plugin state. Plugin names are used for duplicate checks and debugging. The group macro generates documentation for included plugins and their feature gates.

The trade-off is that this ergonomic model assumes trusted, compiled Rust code. It gives plugin authors powerful access to the host App and does not try to make independently distributed plugins safe or compatible by itself.

For CGP, the authoring experience should aim for similarly small entry points while preserving stronger boundaries. A CGP author should not need to understand Foundation internals, but should still receive explicit manifest validation, contract compatibility, Slot ownership, capability grants, lifecycle failures, and backend restrictions.

## 8. Comparison with CGP

| Concern | Bevy | CGP |
|---|---|---|
| Primary goal | Compose a Rust game application and its engine subsystems | Host independently packaged modules without embedding game-domain knowledge |
| Extension unit | Compiled Rust Plugin | Manifest-described module package |
| Composition | App registration and curated PluginGroups | Manifest dependencies and module-owned Slot graph |
| Identity | Rust type/name within an App | Stable package/module IDs and versions |
| Dependency ordering | PluginGroup order and ECS system dependencies | Validated composition graph and deterministic contribution ordering |
| Lifecycle | build, ready, finish, cleanup | discover, validate, resolve, prepare, register, initialize, run, explicit shutdown |
| Trust | In-process trusted code | Trusted JS opt-in or isolated WebAssembly backend |
| Isolation | No Plugin sandbox boundary | Backend-enforced guest isolation and budgets |
| Capability control | App API access through Rust code | Manifest and host policy-controlled capabilities |
| Runtime scheduling | App runner and ECS schedules | Caller-driven dispatch and explicit simulation steps |
| Persistence | ECS/world and scene serialization facilities | Module-owned JSON save slices with host-enforced ownership and restore policy |
| Distribution | Rust crates and build configuration | Independent module package and manifest validation |

## 9. What CGP should and should not take from Bevy

### Worth studying further

1. **Authoring ergonomics:** keep the common module-author path small and make advanced capabilities discoverable.
2. **Reusable composition presets:** consider a declarative preset/profile layer that selects known modules and options, while still resolving through CGP's graph.
3. **Explicit setup readiness:** consider whether CGP will need a distinct asynchronous readiness phase for backends or host-managed services. Do not add it until a real CGP lifecycle requirement exists.
4. **Separate build-time and composition-time modularity:** keep toolchain/deployment packaging separate from runtime composition profiles.
5. **Introspection:** provide clear module/Slot/lifecycle diagnostics and a stable way to inspect the resolved composition.

### Do not copy directly

1. Do not treat an in-process Plugin as an independently loadable or sandboxed module.
2. Do not replace CGP's manifest resolver with a curated plugin list.
3. Do not use panic as the normal error contract for duplicate packages, incompatible versions, or failed composition.
4. Do not interpret Bevy's cleanup phase as a runtime unload lifecycle.
5. Do not allow a parallel frame scheduler to bypass CGP's explicit simulation-step and commit authority.
6. Do not add engine-specific concepts such as entities, rendering, input, or physics to the CGP Foundations.

## 10. Open questions for later Bevy study slices

- How do Bevy's separate crates and feature graph map to an independently installable authoring SDK versus the CGP host runtime?
- How are plugin dependencies and required resources expressed and validated in real Bevy plugins?
- What are the practical boundaries of SubApps and world extraction, and are they useful analogies for nested module-owned Slots?
- How does Bevy hotpatching differ from hot-reloading independently packaged modules?
- What testing, diagnostics, examples, and migration conventions make Bevy's plugin authoring experience effective?
- How does the current 0.20 development line differ from published 0.19/0.20 documentation where APIs have changed?

## Sources

### Pinned upstream source

- [Bevy source revision 7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a)
- [Plugin trait](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin.rs)
- [PluginGroup and PluginGroupBuilder](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/plugin_group.rs)
- [App](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/app.rs)
- [SubApp](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/sub_app.rs)
- [Workspace Cargo features](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/Cargo.toml)
- [Cargo feature guide](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/docs/cargo_features.md)

### Explanatory documentation

- [Bevy plugin quick start](https://bevy.org/learn/quick-start/getting-started/plugins/)
- [Bevy ECS schedule documentation](https://docs.rs/bevy/latest/bevy/ecs/schedule/)
- [Bevy system ordering documentation](https://docs.rs/bevy/latest/bevy/ecs/system/)
