# CGP Architecture Synthesis 001 — Cross-Architecture Findings and Design Boundaries

**Research date:** 2026-11-15  
**CGP comparison baseline:** [4b87d37084a7c5b30fa642763edc5e497452d6d3](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/4b87d37084a7c5b30fa642763edc5e497452d6d3)  
**Studies synthesized:** O3DE 001–003; Bevy 001–003; wasmCloud 001–002; Extism 001–002; OSGi 001–003.  
**Decision status:** Research synthesis only. No architecture decision, ADR amendment, or implementation change is authorized by this document.

## Purpose

The preceding architectural studies examined five ecosystems with different goals and execution models:

- Open 3D Engine (O3DE): reusable packages, project configuration, native module loading, and component services.
- Bevy: compiled application plugins, subsystem composition, ECS data access, and scheduling.
- wasmCloud: WebAssembly components, typed interfaces, capability grants, workload boundaries, and host services.
- Extism: embedded WebAssembly execution, guest SDKs, host functions, state, and runtime failure behavior.
- OSGi: package wiring, requirement/capability resolution, dynamic services, bundle lifecycle, and revision refresh.

This synthesis asks what these systems collectively teach us about CGP, where their approaches genuinely differ, what CGP already implements, and which architectural questions deserve further work.

The goal is not to average five architectures into one. A useful synthesis preserves the reasons they differ.

## Executive conclusion

**CGP is best understood as a composition-and-authority platform with replaceable execution backends, not as a plugin loader or a general-purpose game engine.**

The comparative evidence supports a layered architecture in which:

1. Distribution and artifact acquisition are separate from runtime composition.
2. Package dependencies are separate from module-owned Slot connections.
3. Composition resolution is separate from execution ordering.
4. Typed interface compatibility is separate from authorization and capability grants.
5. Execution isolation is separate from lifecycle, resource accounting, and state authority.
6. Runtime-local state is separate from durable module-owned state and authoritative application state.
7. Concurrency safety is separate from deterministic simulation semantics.
8. Module replacement is a distinct lifecycle feature, not a side effect of package versioning.

CGP already implements meaningful portions of this architecture: closed manifests, exact-version profiles, nested module-owned Slots, explicit capability requirements, deterministic ordering, rollback on composition failure, composition-owned execution sessions, isolated WebAssembly guests, explicit resource budgets, module-owned save slices, and a caller-driven simulation ledger.

The evidence does **not** support a wholesale adoption of any studied framework. It supports preserving CGP's core composition model while borrowing narrowly scoped mechanisms where they solve demonstrated problems.

The largest immediate architectural gap is independent module authoring, packaging, and distribution. The largest unresolved runtime question is whether WIT and the WebAssembly Component Model should become a typed contract layer, a second execution backend, or both. Security identity, state migration, dynamic replacement, and broader scheduling remain separate future design questions.

## 1. Evidence boundary

This synthesis uses the research files in this directory and the current CGP repository state at the comparison baseline above.

The source studies pin specific upstream revisions where practical. They include current development snapshots as well as normative specification references. A pinned implementation observation is evidence about that revision; it is not automatically a permanent public API guarantee.

The synthesis does not claim that every upstream system or every possible configuration was exhaustively tested. It compares the scoped questions actually investigated.

### 1.1 Study inventory

| Ecosystem | Studies | Primary subjects |
|---|---:|---|
| O3DE | 3 | Gem packaging, native module lifecycle, service declarations and ordering |
| Bevy | 3 | Plugin composition, SubApps and hotpatching, ECS access and scheduling |
| wasmCloud | 2 | Component host and capabilities, WIT and Component Model |
| Extism | 2 | Embedded guest execution, SDKs, state, failure recovery, network limits |
| OSGi | 3 | Bundle lifecycle and services, dynamic binding, constraint resolution and refresh |

The studies are comparative research records. They do not amend CGP's accepted ADRs.

## 2. The most important convergence: modularity has multiple layers

A recurring source of architectural confusion is the use of one word—module, plugin, component, package—to describe objects that exist at different layers.

The studied systems demonstrate that these layers must be named and governed separately.

### 2.1 Distribution and artifact layer

This layer answers:

- What is the installable or downloadable unit?
- What files belong to a release?
- Where can a release be discovered?
- Which source revision produced it?
- What digest, license, platform, runtime, and ABI requirements apply?
- How is a reproducible selection recorded?

O3DE makes a useful distinction between a Gem package, the native module a Code Gem can produce, and a remote repository catalog. wasmCloud separates component artifacts from workload specifications and OCI storage. Extism separates a plugin manifest and Wasm modules from the application that hosts them.

**CGP implication:** the runtime manifest, implementation artifact, profile/lock, and repository/catalog record should remain separate concepts. They may reference one another, but should not become one overloaded file.

### 2.2 Package dependency layer

This layer answers which packages can be acquired and selected together.

O3DE resolves Gem dependencies and engine compatibility during project configuration. OSGi uses a general requirement/capability resolver over resources and existing wiring. wasmCloud tooling resolves component and interface artifacts for a workload.

These are not all the same algorithm. OSGi's resolver solves a much richer global wiring problem than a runtime that receives a caller-selected list of exact package versions.

**CGP implication:** CGP's exact-version profile is a useful reproducibility boundary. A future package planner may resolve ranges and emit a locked profile before runtime composition. It should not silently change the Foundations resolver into a backtracking package-universe solver unless CGP actually needs that capability.

### 2.3 Runtime composition layer

This layer answers how selected modules connect and which module owns each extension point.

CGP's defining mechanism is its explicit composition graph and nested module-owned Slots. O3DE's System Component dependency sort, OSGi's service registry, and Bevy's plugin groups are useful comparisons, but none is the same model.

A Slot is not just a service name. It has an owner, a contract, a contribution kind, cardinality/conflict behavior, and dispatch semantics. A module may expose Slots of its own, allowing composition to remain extensible without teaching the Foundations what each domain means.

**CGP implication:** retain Slots as the runtime composition mechanism. Do not replace them with a global mutable service bus or equate them with WIT interfaces.

### 2.4 Interface and ABI layer

This layer answers how independently built code represents data and calls across a module boundary.

The current CGP guest ABI is a custom JSON protocol over core WebAssembly Modules. Extism demonstrates a practical bytes-in/bytes-out embedded guest model. wasmCloud and the Component Model demonstrate standardized typed imports, exports, WIT worlds, resources, and the Canonical ABI.

WIT describes interface shape and types. It does not decide CGP module identity, provider selection, Slot ownership, trust policy, scheduling, state authority, or composition lifecycle.

**CGP implication:** WIT is a serious candidate for typed contracts at the isolated guest boundary, but it must be evaluated as a layer beneath CGP composition, not as a replacement for composition.

### 2.5 Execution and isolation layer

This layer answers where module code runs and what authority it can exercise.

The studies reveal materially different trust boundaries:

- Bevy plugins execute as compiled application code with access to the App and its process.
- O3DE native modules execute in the host process.
- OSGi bundles have class-loader and framework boundaries but share a JVM process.
- wasmCloud distinguishes untrusted workload components from trusted host plugins and persistent service components.
- Extism embeds a Wasm runtime and gives the host control over imports and guest lifecycle.
- CGP distinguishes trusted in-process JavaScript from isolated WebAssembly guests.

**CGP implication:** package identity and manifest declarations are not security boundaries. A backend must truthfully state which grants and limits it can enforce. A host callback is itself privileged code and needs its own validation and budget.

### 2.6 Lifecycle and state layer

This layer answers who owns module instances, how initialization and shutdown proceed, what happens after failure, and when old code can be retired.

O3DE demonstrates staged native loading and explicit destruction ordering. OSGi demonstrates installed bundle revisions, removal-pending wiring, and dependent-closure refresh. OSGi Declarative Services demonstrates that dynamic service rebinding introduces concurrency and resource-lifetime obligations. Extism shows that resetting call buffers is not the same as recreating a guest instance and that a failed call may leave state mutated.

**CGP implication:** lifecycle must remain explicit. Composition rollback, module shutdown, backend release, guest reset, durable restore, and future replacement are distinct operations. No one should infer stronger guarantees from another.

## 3. Cross-architecture comparison

The following table identifies each ecosystem's strongest contribution to CGP and the limit of the analogy.

| Ecosystem | Strongest contribution | What it does not provide to CGP |
|---|---|---|
| O3DE | Package/catalog separation, compatibility metadata, native loading lifecycle, required/optional/incompatible service semantics | A WebAssembly security boundary or CGP-style nested Slot composition |
| Bevy | Low-friction subsystem authoring, curated presets, typed ECS access metadata, conflict diagnostics, explicit deferred-application boundaries | Independently packaged sandboxed plugins, a package dependency resolver, transactional simulation commits |
| wasmCloud | Component-host boundaries, WIT contracts, explicit grants, workload resource policy, separation of host plugins and guest components | CGP's exact nested Slot ownership and deterministic simulation ledger |
| Extism | Embedded Wasm execution, byte-oriented ABI, host-function linking, guest SDK patterns, instance resource controls | Package graph resolution, nested Slots, module profile selection, transactional host state |
| OSGi | Requirement/capability modeling, dependency diagnostics, dynamic service lifecycle, reference cardinality, revision retirement and refresh | Process isolation or a guarantee that graph-wide update/refresh is transactional |

### 3.1 O3DE: distinguish package, module, and service ordering

O3DE's three studies show why its concepts must not be collapsed:

- A Gem is a reusable package; a Code Gem can produce a native module.
- The ModuleManager loads and owns native code and activates System Components.
- Component service declarations express provided, required, dependent, and incompatible relationships.
- Dependency sorting is scoped to components and activation contexts; it is not the same as CGP's entire module/Slot graph.

The strongest transfer is packaging discipline and explicit lifecycle ownership. The required-versus-optional distinction is also useful, but CGP already models required and optional capability requirements.

### 3.2 Bevy: distinguish plugin composition from execution scheduling

Bevy's Plugin is an application configurator, not an independently distributed runtime package. PluginGroups are curated presets. The ECS scheduler has its own system graph, access metadata, conflict analysis, and deferred commands.

These mechanisms are not interchangeable:

- Plugin installation does not resolve external package dependencies.
- ECS ordering does not resolve module packages.
- A read/write conflict prevents unsafe overlap; it does not define semantic order.
- A parallel schedule can have multiple valid interleavings.
- Deferred commands provide a synchronization boundary, not an all-or-nothing validated state transaction.
- Hotpatching functions is not module package replacement or unload.

The strongest transfer is developer ergonomics and, if CGP eventually adds a general-purpose scheduler, typed access declarations and conflict diagnostics.

### 3.3 wasmCloud: distinguish interface, permission, and execution role

wasmCloud v2 separates workload components, host plugins, and long-running service components. It also separates typed WIT interfaces from the host's decision about which implementations are granted and linked.

This yields three important principles:

- A declared import is an interface dependency, not automatically an authorization grant.
- A native host plugin and an isolated guest component are different trust classes.
- A persistent service role has different lifecycle, state, and concurrency requirements from an invocation-oriented component.

The strongest transfer is the separation of typed interface contracts, host capability implementation, and workload policy. Kubernetes and a distributed control plane are not prerequisites for CGP's current objective.

### 3.4 Extism: distinguish guest execution from module platform

Extism is an embedded runtime and SDK ecosystem. It provides guest construction, host-function imports, memory marshalling, and runtime controls, but leaves package discovery, selection, authorization, and composition to the host application.

Its studies exposed several operational traps:

- A byte-oriented ABI does not imply typed contract compatibility.
- Reset can clear host-side buffers without recreating guest memory or globals.
- A failed call is not a transaction.
- Reusing a failed guest instance requires an explicit health/retirement decision.
- A hostname allowlist checked only before the initial HTTP request does not establish per-redirect destination safety.
- Fuel limits guest instructions, not arbitrary host callback work.
- A per-plugin budget does not automatically become an aggregate budget across compositions.

The strongest transfer is guest runtime and SDK ergonomics. CGP's host must retain stronger composition-wide accounting and host-owned state policy.

### 3.5 OSGi: distinguish package wiring, service binding, and revision refresh

OSGi demonstrates a mature, dynamic runtime where package identity, service binding, lifecycle state, and revision wiring all have explicit semantics.

Its studies reveal:

- Generic requirements/capabilities and package-space constraint solving are more general than topological ordering.
- Java package uses constraints protect class-space consistency; they are not general module contracts.
- Declarative Services turns reference cardinality and satisfaction into activation conditions.
- Dynamic bindings can change while service methods are running and require concurrency-safe rebinding and object release.
- Update introduces a new revision; old wiring can remain in use.
- Refresh computes a dependent closure, stops and unresolves affected bundles, and attempts re-resolution. This is not an atomic application-wide replacement.

The strongest transfer is lifecycle diagnostics, provider lifetime, and explicit replacement semantics. The shared JVM is not a sandbox, and CGP does not need OSGi's global mutable service registry by default.

## 4. The distinct graphs CGP must preserve

A major synthesis result is that "the dependency graph" is too imprecise. At least five different graphs or orderings may exist in a mature modular platform.

### 4.1 Package acquisition graph

Packages depend on other packages, interface packages, toolchains, or platform artifacts. This graph is used to acquire and lock artifacts. It can eventually require range solving and platform filtering.

**Owner:** package tooling/catalog and lock generation.

### 4.2 Composition dependency graph

Selected modules require capabilities and connect to module-owned Slots. This graph determines whether a composition is valid and which modules depend on which providers.

**Owner:** CGP Foundations composition resolver.

### 4.3 Slot contribution structure

A module-owned Slot has contributions, cardinality, contract identity, and dispatch behavior. The structure may be nested without exposing domain semantics to Foundations.

**Owner:** Slot owner plus CGP contract enforcement.

### 4.4 Lifecycle execution order

A valid composition has deterministic initialization and reverse shutdown order. This is an execution policy derived from the admitted composition graph and lifecycle phases.

**Owner:** CGP host lifecycle.

### 4.5 Internal work/simulation schedule

A module or higher-level runner may schedule systems, jobs, or steps inside its own domain. Bevy's ECS graph is a useful reference here, but a system schedule is not the package or composition graph.

**Owner:** module or explicit simulation/scheduler subsystem, subject to host authority.

### Consequence

These graphs may reference related entities, but they have different node identities, failure conditions, and ordering guarantees. A future architecture must not merge them into one universal scheduler or resolver merely for conceptual neatness.

## 5. Current CGP architecture: what the synthesis validates

The current repository status and accepted ADRs demonstrate that CGP has moved beyond a paper design. The Foundations have a functioning composition proof through isolated WebAssembly guests.

The following are recorded as implemented in the reviewed repository state:

| Area | Current CGP capability |
|---|---|
| Manifest validation | Closed JSON schema, semantic versions and compatibility ranges |
| Package selection | Composition profiles pin exact module IDs and versions; the host does not upgrade |
| Dependency resolution | Required/optional capabilities, explicit provider pinning, ambiguity refusal |
| Nested modularity | Modules own Slots; child packages can connect without editing parent or Foundations |
| Slot behavior | Singleton, policy, registry, pipeline, subscriber, service |
| Composition graph | Cycle detection, dependency edges, deterministic ordering and conflict refusal |
| Lifecycle | Discover, validate, resolve, prepare, register, initialize, run, shutdown |
| Failure handling | Bad manifests are isolated; graph/init failures roll back the admitted composition |
| Dispatch | Caller-initiated publish, pipeline, and service calls; no host-owned tick loop |
| Reproducibility | Composition fingerprints include module versions, contracts, dependency edges and contribution order |
| Isolated execution | Composition-owned WebAssembly worker sessions, allowlisted imports and guest memory limits |
| Resource policy | Per-composition guest/memory/binary/hook budgets and backend-wide host ceilings |
| Session release | In-flight calls and workers are tracked; release waits for worker termination |
| Persistence | Module-owned JSON save slices and serialized capture/restore behavior |
| Simulation integrity | Caller-driven proposals, an authoritative ledger, explicit commit validation and completion events |
| Browser proof | Shared composition function and WebAssembly isolate proof in Chromium |

The current status also records deliberate limits:

- No physics, renderer, input, audio, multiplayer, or network replication.
- No automatic scheduler or self-advancing clock.
- No hot module reload.
- No general module-local scratch transaction or prepare/commit/abort protocol.
- No save migration beyond the current major-version compatibility rule.
- No enforced permissions for trusted in-process JavaScript.
- No general package registry or independent public SDK release workflow documented as complete.

The last group is not a criticism. It separates proven behavior from future capability.

## 6. Architectural invariants reinforced by the research

The following principles are sufficiently supported across the studies to serve as synthesis-level guardrails. They are not new accepted ADRs.

### 6.1 Identity must be explicit at every layer

Do not conflate:

- logical module ID;
- package release/version;
- artifact digest;
- ABI or interface package version;
- profile/lock identity;
- composition fingerprint;
- runtime instance/session identity;
- Slot ID and contribution ID;
- durable save schema version.

Each answers a different question. A module ID alone cannot identify immutable executable bytes or a particular runtime instance.

### 6.2 Interface compatibility is not permission

An interface says what can be called and how values are represented. A grant says whether the caller may use it. A host implementation says what authority the call actually provides.

WIT types, manifest declarations, or import names do not replace runtime authorization.

### 6.3 Isolation is not a complete security model

A Wasm sandbox reduces guest authority only to the degree enforced by the runtime and linked imports. Host callbacks remain privileged code. Artifact provenance, caller identity, authorization, resource quotas, network destination policy, logging, and information leakage require their own design.

The trusted JavaScript backend must continue to be described as trusted in-process execution, not a sandbox.

### 6.4 Failure is not rollback unless the operation owns a transaction

Guest traps, timeouts, host callback failures, service errors, lifecycle hook failures, and persistence failures can occur after some work has already happened.

Each operation must state:
- which state can have changed;
- what cleanup is guaranteed;
- whether the same instance may be reused;
- whether a host-owned commit occurred;
- what diagnostics are retained.

CGP's current proposal/ledger boundary is stronger than arbitrary guest call rollback and should remain explicit.

### 6.5 Determinism needs authority, not just ordering

A topological order or conflict-free schedule does not automatically guarantee replay-equivalent outcomes. Determinism also depends on:
- which operations can mutate authoritative state;
- which input snapshot a module sees;
- how ties and contributions are ordered;
- how asynchronous completions are assigned to steps;
- how external effects are recorded;
- when commits become visible;
- what save capture includes.

The host-owned simulation ledger and operation lane address a narrower, testable part of this problem. They should not be generalized beyond their actual guarantees.

### 6.6 Replacement requires a generation and retirement policy

A future replacement feature must define how old and new module generations coexist, what happens to in-flight calls and handles, when the new composition becomes visible, how save state migrates, and what happens when preparation fails.

OSGi proves that revision lifetime and dependent closure matter. It does not prove that CGP should implement live replacement now.

## 7. Gaps and unresolved design questions

The synthesis identifies the following work areas. They are candidate future programs, not automatic implementation instructions.

### 7.1 Independent authoring, packaging, and distribution — highest immediate priority

Current evidence:
- CGP has a public Foundations entry point and copyable JavaScript and WebAssembly examples.
- The authoring guide describes a package as a folder with a manifest and implementation.
- The root package.json is currently marked private and the JavaScript starter imports the Foundations entry through a repository-relative path.
- The current docs do not establish a released, independently installable SDK, immutable artifact catalog, or complete publishing workflow.

O3DE's separation of package, built module, compatibility metadata, and remote catalog is directly relevant. wasmCloud's artifact and workload separation and Extism's manifest/PDK split reinforce it.

Questions:
- What exactly is a distributable CGP package?
- Is JavaScript source a development format, a trusted runtime format, or both?
- What is the canonical WebAssembly artifact package?
- How are the Foundations SDK and guest SDK versioned independently?
- What fields bind module release, source revision, artifact digest, ABI/interface version, license, target runtimes, and platform compatibility?
- How does a profile lock a package to immutable bytes?
- What is the smallest useful local catalog and install workflow before any public registry is needed?

### 7.2 WIT compatibility and typed guest contracts — high research priority

Questions:
- Can WIT fit behind CGP Slots without replacing Slot ownership and resolution?
- What is the minimal WIT surface for service and registry Slots?
- Can resource handles preserve composition-scoped authorization and stale/cross-composition refusal?
- What runtime and browser artifact paths are supportable?
- What measurable build, package size, startup, memory, call overhead, and portability costs result?
- Should WIT be the guest ABI, a typed SDK/adaptor layer over cgp.abi/1, or a backend-specific option?

No ABI migration is justified before a working cross-runtime prototype and comparison.

### 7.3 Security and identity model — high priority before expanding grants

Questions:
- Which principals exist: caller, module, composition, host service, publisher, and operator?
- Which identity is carried across an ABI call?
- Can a shared host capability distinguish one composition or module from another?
- How are grants scoped, revoked, audited, and budgeted?
- What threat model applies to host plugins, trusted JavaScript, isolated guests, artifact acquisition, and generated tooling?
- How are network destinations, redirects, DNS rebinding, and host callback work constrained if network capability is ever added?

The current narrow guest import surface is useful. It should not be expanded merely to make examples easier.

### 7.4 State migration and durable storage

The current save model has module-owned JSON slices and a major-version compatibility boundary. It does not define a general migration framework or an independent durable storage subsystem.

Questions include:
- Which versions can migrate to which versions?
- Are migrations pure transformations or allowed to call capabilities?
- Are migration steps versioned and chained?
- How is rollback guaranteed if one module's migration fails after another's state was transformed?
- How do profile identity and composition generations affect restore?
- When should durable storage remain module-owned versus be offered as a host capability?

Do not confuse rebuilding a guest instance with migrating durable state.

### 7.5 Long-running services, concurrency, and leases

wasmCloud service components and OSGi dynamic services show that persistent service roles introduce different concurrency and lifetime requirements than short invocation hooks.

Questions:
- Does CGP need a persistent service role distinct from the current service Slot?
- What is the maximum concurrency of a module instance?
- How are in-flight calls drained during shutdown?
- Are provider snapshots immutable for an operation?
- Is provider replacement ever allowed during an active composition?
- What happens when a provider becomes unhealthy or is removed?
- Are explicit leases required, or can composition-owned handles and session lifetime cover the use cases?

This should remain unresolved until a concrete workload needs long-lived service instances or dynamic rebinding.

### 7.6 General scheduling and parallel execution

Bevy demonstrates strong typed access scheduling, but also shows why safe parallelism does not imply deterministic ordering.

Questions:
- Does CGP need a scheduler beyond its caller-driven pipelines?
- Would it schedule module contributions, internal jobs, or both?
- What access declarations are required?
- Can work be classified as pure, proposal-producing, read-only, or authoritative mutation?
- How are external side effects handled?
- What deterministic result must remain invariant across worker counts and runtime backends?

The current serial operation lane and ledger are sufficient for the current proof. Parallel scheduling is not an immediate requirement.

## 8. A candidate layered architecture envelope

The studies support the following conceptual layering. It is an organizing model for future specifications, not an approved redesign.

~~~text
Developer tools / SDKs
        |
Package catalog and artifact acquisition
        |
Immutable module artifacts + provenance
        |
Profile / lock resolution
        |
CGP Foundations composition
  - manifest validation
  - module identity
  - capability requirements
  - module-owned Slots
  - graph validation and ordering
        |
Contract / ABI boundary
  - current cgp.abi/1
  - possible WIT contract layer / adapter
        |
Execution backend
  - trusted in-process backend
  - isolated WebAssembly backend
  - possible Component Model backend
        |
Host-granted capabilities and budgets
        |
Module lifecycle / session ownership
        |
Module-owned state + host-authoritative operations
        |
Domain modules / optional simulation or scheduling systems
~~~

Important ownership boundaries:

| Layer | Authority it should own |
|---|---|
| Catalog/acquisition | Discovery, source, release metadata, artifact retrieval and integrity |
| Profile/lock | Exact package and artifact selection |
| Foundations | Manifest validity, composition graph, Slot ownership, dependency resolution, deterministic lifecycle order |
| Contract/ABI | Type and serialization compatibility at a module boundary |
| Backend | Actual execution mechanism, isolation and enforceable runtime limits |
| Capability host | The concrete authority of each granted host operation |
| State/operation owner | Durable module state and domain-specific authoritative mutation |
| Domain module | Game-specific behavior, schemas, scheduling and policy |

No layer should claim to enforce a property that belongs to another layer.

## 9. Priority order and proposed next slices

The order below is a research recommendation based on current gaps, not a release schedule.

| Priority | Slice | Reason |
|---|---|---|
| 1 | Independent package, artifact, SDK, and local catalog specification | Directly closes the most visible M4 gap and makes third-party modules genuinely independent |
| 2 | Minimal WIT compatibility prototype | Resolves the largest open ABI question with measurable evidence |
| 3 | Threat model and capability identity review | Required before exposing more powerful host capabilities |
| 4 | Save migration and durable storage design | Needed before promising stable long-term module upgrades |
| 5 | Long-running service and provider-lifetime study | Only if the product needs persistent services or dynamic provider replacement |
| 6 | Scheduler and parallel execution investigation | Only if demonstrated workloads exceed the current caller-driven model |

### Recommended next study slice

**CGP Study 001 — Independent Module Package, Artifact, and SDK Contract**

Focus on the exact independently distributable unit and its relationship to:
- manifest and module identity;
- JavaScript and WebAssembly implementation artifacts;
- Foundations API and guest ABI compatibility;
- source revision and artifact digest;
- license and publisher provenance;
- platform/runtime support;
- exact profile lock entries;
- local catalog and install workflow;
- validation before execution.

Use O3DE Gem/repository metadata, wasmCloud component/workload packaging, Extism manifests and PDKs, and the current CGP starter packages as evidence. Do not design a public network registry yet. First define a reproducible local package and lock workflow.

The output should be a proposed package contract with examples and explicit non-goals, not an implementation PR. Any accepted format change should receive its own ADR after trade-offs are reviewed.

## 10. Non-decisions

This synthesis does not decide to:

- replace cgp.abi/1 with WIT;
- add Extism, wasmCloud, O3DE, Bevy, or OSGi as CGP runtime dependencies;
- add native shared-library plugins;
- introduce a global mutable service registry;
- implement hot reload or dynamic provider rebinding;
- add a parallel ECS or automatic simulation clock;
- add networking, multiplayer, renderer, physics, or audio systems;
- publish a package registry;
- change current accepted ADRs or weaken the current guest isolation boundary.

These remain possible future directions only when justified by requirements and evidence.

## Conclusion

The five ecosystems do not converge on one universal module architecture. They converge on the need to separate package identity, dependency resolution, runtime composition, interface contracts, execution trust, lifecycle, state ownership, and scheduling.

CGP already has a distinctive core: explicit composition through module-owned Slots, backend-aware execution, controlled lifecycle, and host-owned authority over the current simulation proof. Those are the foundations to preserve.

The next useful step is not to add another large runtime feature. It is to make CGP's modules independently authorable, packageable, and reproducibly selectable. Once that contract is clear, the WIT compatibility prototype and threat-model work can proceed against a stable package boundary.

**No CGP implementation code or ADR was changed as part of this synthesis.**
