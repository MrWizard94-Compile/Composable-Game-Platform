# OSGi Study 003 — Constraint Resolution, Class-Space Consistency, and Revision Refresh

**Research date:** 2026-11-15  
**Normative baseline:** OSGi Core Release 8 (latest final release located for this study); Release 9 is listed as a development draft  
**Implementation examined:** Eclipse Equinox  
**Equinox source revision:** [1200da8f6e7ea3ffa049aaf8ffe9967ba1954327](https://github.com/eclipse-equinox/equinox/commit/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327)  
**CGP comparison baseline:** [d24266e79a91036f0e08b66c2a3040f0326d6dbb](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/d24266e79a91036f0e08b66c2a3040f0326d6dbb)  
**Related studies:** [001 — Bundle lifecycle, service registry, and dynamic modularity](001-bundle-lifecycle-services-and-dynamic-modularity.md); [002 — Declarative Services, dynamic binding, and concurrency](002-declarative-services-dynamic-binding-and-concurrency.md)

## Purpose and decision boundary

This study examines two mechanisms that are easy to conflate but solve different problems:

1. OSGi's requirement/capability resolver, including package class-space consistency and the role of the resolver context.
2. OSGi's revision update and refresh process, including old wiring, removal-pending revisions, dependent closure, and re-resolution.

The first determines whether a collection of modules can be wired consistently. The second changes existing wiring while managing consumers that may still depend on an older revision.

This is comparative research, not an implementation decision. It does not authorize replacing CGP's manifest or Slot model, introducing a general-purpose package resolver, changing profile semantics, or implementing hot replacement.

## Executive findings

1. **OSGi resolution is constraint solving, not just dependency ordering.** It chooses a globally consistent set of requirement-to-capability wires across a transitive graph. In the general case this can be computationally difficult; the Resolver specification explicitly discusses the NP-complete nature of the problem.
2. **Candidate discovery and constraint solving are separate responsibilities.** The OSGi resolver consumes a ResolveContext. The context exposes resources, candidate capabilities, existing wirings, filtering policy, and singleton decisions; the resolver performs the constraint-solving work, including package uses constraints.
3. **The uses directive protects Java class-space consistency.** If an exported package's API depends on another package, consumers must not wire that dependency to a conflicting exporter. This prevents incompatible class identities from entering one bundle's view of a type graph.
4. **A uses constraint is not a general-purpose module dependency.** It is tied to Java package wiring and class-space consistency. It should not be copied literally into CGP's game-system Slots or treated as a generic substitute for declared capabilities.
5. **Resolution produces a wiring delta against existing state.** A resolver must account for already-established wires; it cannot always treat the whole installed population as an empty graph and independently choose every provider again.
6. **Update and refresh are separate operations.** Updating a bundle creates a new revision. Existing consumers can continue using old wiring, leaving an older revision removal-pending while it remains in use.
7. **Refresh operates on a dependent closure.** It stops affected active bundles, removes obsolete wiring, makes old revisions eligible for cleanup, and attempts to resolve and restart the affected modules. It is not a one-object pointer swap.
8. **Refresh is not an application-wide transaction.** Failure to resolve after refresh can leave modules unresolved. Lifecycle failures and recovery behavior must be understood separately from the resolver's wiring result.
9. **Equinox's tests make these states observable.** Its container tests exercise removal-pending revisions, repeated updates, refresh, uninstall, dependent modules, and substitutable exports. Its resolution-report tests distinguish missing capabilities, unresolved providers, and singleton-selection failures.
10. **CGP currently has a deliberately narrower problem.** It composes a caller-selected set of exact package versions, owns explicit nested Slots, and rejects ambiguous providers. Its deterministic topological order is an execution-order decision after graph admission, not a substitute for OSGi's package-space solver.

## 1. Evidence boundary and primary sources

### Normative OSGi sources

- [OSGi specifications overview](https://docs.osgi.org/specification/) — Release 8 is the latest final Core/Compendium baseline located; Release 9 is listed as a development draft.
- [OSGi Core Release 8 — Module Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.module.html) — requirements, capabilities, package wiring, and uses constraints.
- [OSGi Core Release 8 — Resolver Service](https://docs.osgi.org/specification/osgi.core/8.0.0/service.resolver.html) — resolver and ResolveContext responsibilities, consistent resolution, and resolution results.
- [OSGi Core Release 8 — Bundle Wiring API](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.wiring.html) — revisions, wirings, dependency closure, refresh, and removal-pending behavior.

### Pinned Equinox implementation

The implementation observations below are specific to the pinned Equinox revision, not universal requirements imposed on every OSGi implementation.

- [ModuleResolver.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/container/ModuleResolver.java)
- [ModuleContainer.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/container/ModuleContainer.java)
- [FrameworkWiring.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/osgi/src/org/osgi/framework/wiring/FrameworkWiring.java)
- [TestModuleContainer.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi.tests/src/org/eclipse/osgi/tests/container/TestModuleContainer.java)
- [ResolutionReportTest.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi.tests/src/org/eclipse/osgi/tests/container/ResolutionReportTest.java)

### CGP baseline

The comparison uses CGP commit **d24266e79a91036f0e08b66c2a3040f0326d6dbb**. It is the repository HEAD after OSGi studies 001 and 002 were added. The intervening commits changed study documentation only; the CGP implementation was not modified between the OSGi 001 implementation baseline and this study baseline.

Relevant CGP records:

- ADR 0002 — Manifests, Slots, and Resolution
- ADR 0003 — Execution, Trust, and Lifecycle
- ADR 0008 — Composition Profiles
- ADR 0010 — Execution Boundary
- ADR 0016 — Simulation Integrity
- docs/STATUS.md

## 2. Requirement/capability resolution: what the resolver actually solves

OSGi models a module as a Resource that can expose Capabilities and declare Requirements. Each capability and requirement belongs to a namespace. Attributes and directives describe properties and constraints; filters can restrict which capabilities satisfy a requirement.

For example, a package requirement is not merely “find any bundle named X.” It asks for a capability in the package-wiring namespace with matching package identity and compatible attributes such as version. Other namespaces can express different kinds of capability relationships.

The resolver must consider more than one isolated requirement at a time. A candidate selected for one requirement can constrain the candidates available for another requirement elsewhere in the transitive graph. The final result must be a consistent wiring set, not just a list of individually plausible matches.

### 2.1 Resolver versus ResolveContext

The Resolver Service specification divides responsibility:

| Responsibility | Primary owner |
|---|---|
| Describe mandatory and optional resources to consider | ResolveContext |
| Enumerate candidate capabilities for a requirement | ResolveContext |
| Expose already resolved wirings and environment policy | ResolveContext |
| Apply resolver hooks and candidate filtering policy | Framework / ResolveContext integration |
| Select a globally consistent set of wires | Resolver |
| Enforce package uses consistency during constraint solving | Resolver |
| Return the resulting wiring delta or a resolution failure | Resolver |

This division is important. The resolver is not necessarily the package catalog, repository client, trust-policy engine, or provider-selection UI. The context determines which resources and candidates are visible and supplies the existing wiring environment. The resolver solves the constraints over that supplied problem.

The Resolver specification also makes clear that candidate matching and singleton selection are not simply hidden, universal heuristics inside the solver. The ResolveContext is part of the policy boundary for those decisions.

### 2.2 Existing wiring participates in new resolution

The resolution result is a delta. Existing wirings are part of the context against which new resources are resolved. The framework therefore does not freely rewrite every established provider relationship whenever a new bundle arrives.

This matters when a runtime is already in use. Re-selecting a provider could make previously compatible consumers disagree about the identity of a package or type. Existing wiring is not just cached output; it is part of the runtime's current class-space state.

### 2.3 Why the resolver is more than a topological sort

A topological sort answers an ordering question after dependencies are known and a directed acyclic graph exists.

OSGi resolution must first determine whether a valid graph exists at all, and which candidate providers can coexist under transitive namespace constraints. It can encounter several candidate providers, optional requirements, singleton restrictions, existing wires, and package-space constraints that make an apparently valid local choice globally invalid.

Only after a valid wiring exists do lifecycle and start-order policies determine when modules are resolved or activated.

**CGP distinction:** CGP's topological ordering is intentionally downstream of graph admission. It determines deterministic lifecycle ordering from already-resolved capability and Slot edges. It is not intended to search a package universe for a globally consistent class space.

## 3. Package uses constraints and class-space consistency

The OSGi uses directive is a package-wiring rule. An exported package can declare that its API uses types from another package. A consumer wiring to that export must see a consistent exporter for the packages involved.

Consider this simplified example:

1. Bundle A exports package P.
2. Types in P refer to types from package Q.
3. A itself wires Q to exporter Q1.
4. Bundle D imports P from A.
5. D also attempts to import Q directly from exporter Q2, a different version or provider.

If A's export declares that P uses Q, the resolver must not create a class space where D sees P from A (whose Q identity is Q1) but sees Q from Q2. These two class spaces can contain types with the same binary name but different class-loader identity. That can lead to type incompatibility and ClassCastException even when the names look identical.

The uses directive therefore constrains package-space consistency across a transitive relationship. It does not mean “automatically import Q for every consumer”; it constrains the wires when the related packages are part of the consumer's wiring.

### 3.1 What this rule is not

A uses constraint is not:

- a general module-to-module dependency declaration;
- a game-system capability;
- an execution-order rule;
- a lifecycle dependency;
- a state ownership or mutation rule;
- proof that module behavior is semantically compatible.

It protects Java package and type identity in a class-loader-based module system.

### 3.2 CGP and typed interfaces

CGP has a different boundary. Its modules contribute opaque payloads through Slots and may interact through explicit contract references. The host does not share Java classes between arbitrary modules, nor does it create a JVM class space.

The ongoing WIT / Component Model investigation may create richer typed interfaces across isolated module boundaries. Those types can have their own transitive interface dependencies and versioning concerns, but that does not automatically imply OSGi's Java uses rule should be copied.

The appropriate question for CGP is whether its typed ABI and package tooling can detect inconsistent interface versions or incompatible transitive type dependencies before instantiation. That is a future contract-validation question, not a reason to add class-loader semantics to Foundations today.

## 4. Resolution diagnostics, candidate policy, and failure

A useful resolver must explain why a resource did not resolve, but resolution diagnostics have limits. The Resolver specification cautions that a report of unresolved requirements is not necessarily a complete or unique minimal explanation of every conflict. A candidate that would satisfy one requirement in isolation may still prevent the overall graph from resolving because of another constraint.

The pinned Equinox tests make several failure classes explicit:

- A resolver hook can filter every candidate, producing a filtered-by-hook report.
- A singleton-selection failure is reported separately from a missing capability.
- A missing package capability identifies the required namespace and package name.
- An unresolved provider can be reported separately from the provider's own missing capability.
- Resolver reports associate entries with the resource whose resolution failed.

This is a more useful diagnostic model than a generic “dependency missing” message. It also shows why a single missing edge does not always explain the complete problem.

### 4.1 Cancellation and resource management

The Resolver specification allows resolution to be canceled through the supplied context. The pinned Equinox resolver has timeout/cancellation handling and batches resources for resolution. In ModuleResolver, a canceled or memory-exhausted batch can fall back to resolving resources individually.

That behavior is an Equinox implementation detail, not a promise that every OSGi runtime uses the same batching strategy. The portable lesson is that a large resolver must define work limits, cancellation behavior, and truthful partial/failure reporting.

### 4.2 CGP diagnostic opportunity

CGP already distinguishes missing requirements, ambiguity, cycles, contract mismatch, and lifecycle failure. OSGi suggests a useful future improvement if CGP grows a package catalog or more complex dependency policy: diagnostics should explain not only the failed edge but also which provider candidates were considered, which constraints eliminated them, and which dependent resources became unresolved as a consequence.

A report should not claim to have found a mathematically minimal conflict set unless the resolver actually computes one.

## 5. Revision identity, update, and removal-pending wiring

OSGi distinguishes a bundle's stable installed identity from its executable revision and the wiring attached to that revision.

Updating a bundle creates a new revision. Consumers already wired to the previous revision do not necessarily switch immediately. The old revision can remain in use through existing wires, even though it is no longer the current revision.

The framework exposes removal-pending revisions: non-current revisions whose wiring is still in use. This makes delayed retirement observable rather than silently unloading code that active consumers still reference.

This is a critical lifetime distinction:

- **Bundle identity** describes the installed logical unit.
- **Revision** describes a particular version of its content.
- **Wiring** describes the resolved connections for that revision.
- **Removal-pending** describes an old revision that is no longer current but remains referenced by active wiring.

These are related, but they are not interchangeable.

## 6. Refresh: the dependent closure is the unit of change

The OSGi FrameworkWiring API describes refresh as a multi-stage operation:

1. Compute the dependency closure of the requested bundles. When no explicit seeds are supplied, use removal-pending bundles.
2. Stop active bundles in the closure.
3. Unresolve resolved bundles in the closure, invalidating their old wiring.
4. Remove uninstalled bundles from the closure as appropriate.
5. Resolve and restart bundles that were active before refresh, subject to the framework's lifecycle and start-level rules.
6. Notify listeners when refresh completes.

The dependency closure is important: it includes bundles that are wired to the selected bundle's capabilities—that is, its consumers and their dependent consumers, transitively. It is not simply the same thing as “all prerequisites this bundle requires.”

### 6.1 Refresh can leave a graph unresolved

Refresh attempts to resolve the affected modules against the currently available revisions and candidates. If a required provider is no longer available or the new revisions are incompatible, a consumer can remain unresolved. Refresh is therefore not guaranteed to turn every old graph into a valid new graph.

This is not a transactional graph replacement in which the framework promises either “all old modules remain active” or “all new modules are active.” Update and refresh are explicit lifecycle events with observable intermediate states and possible resolution failures.

### 6.2 Asynchronous completion

The FrameworkWiring API specifies that refresh can complete asynchronously and provides listener/event notification for completion. A caller must not treat the initial refresh request as proof that stop, unresolve, re-resolution, and restart have already completed.

### 6.3 Equinox implementation observations

At the pinned Equinox revision:

- ModuleContainer.getRefreshClosure uses currently wired dependents and traverses them recursively. For fragment revisions it also accounts for the host relationship.
- ModuleContainer.unresolve0 takes a wiring snapshot, computes the closure, and acquires module state-change locks before modifying the graph.
- Active modules are stopped in reverse order through the refresh sequence. Stop failures are reported as container errors; the implementation continues its cleanup flow.
- The implementation removes obsolete wires from provider-side wire lists, invalidates removed wire and wiring objects, removes obsolete revisions/capabilities, and cleans up removal-pending state.
- Modules that were resolved are moved back to an installed/unresolved state before the subsequent resolution attempt.
- ModuleContainer.refresh subsequently calls resolve on the refresh triggers with mandatory resolution disabled, then returns the resulting report unless the system module is being refreshed.

These are observations about Equinox's implementation at the pinned revision. The portable API contract is the normative OSGi specification, not every internal locking, ordering, or cleanup detail listed above.

## 7. Equinox test evidence

The pinned Equinox tests provide concrete examples of the resolver and refresh behavior.

### 7.1 Removal-pending lifecycle

TestModuleContainer.testRemovalPending exercises the following sequence:

- Resolve modules with existing wiring.
- Update a resolved module, including an update with identical content.
- Confirm that the old revision is reported as removal-pending.
- Repeat the process with another module and confirm multiple old revisions can remain pending.
- Call refresh(null) and verify the removal-pending collection becomes empty.
- Uninstall a module and refresh again, verifying the old revision is cleaned up.
- Refresh a dependent module and verify the removal-pending uninstalled module is also cleaned up through the closure.

The important result is not that every update instantly replaces old code. It is that old revisions remain observable while referenced and are retired through refresh.

### 7.2 Substitutable exports

TestModuleContainer.testSubstitutableExports01 verifies that a revision may initially import a package from an older revision of itself while its prior wiring remains in use. After refresh, the current revision's package exports and imports change to the newly applicable wiring.

This is a concrete demonstration that “current revision” and “current wiring state” do not instantly collapse into one object at update time.

### 7.3 Structured resolution reports

ResolutionReportTest includes explicit cases for:

- candidate filtering by resolver hooks;
- singleton selection failure;
- missing capabilities;
- unresolved providers;
- a dependent whose provider itself has a missing capability.

The test data demonstrates that resolution failure has a dependency path and failure category. A useful report must preserve enough of that path for a developer to identify the actual blocker.

These tests are implementation evidence for Equinox, not a claim that every OSGi implementation emits identical diagnostic text or uses identical internal data structures.

## 8. Comparison with CGP

| Concern | OSGi | Current CGP design |
|---|---|---|
| Candidate universe | Framework resources and capabilities made visible to ResolveContext | Caller supplies a package catalog/profile for composition |
| Dependency model | Generic namespaced Requirements and Capabilities | Explicit capability requirements and module-owned Slots |
| Provider selection | ResolveContext policy and resolver constraints, including singleton and namespace rules | One matching provider or explicit module pin; ambiguous matches refuse |
| Graph admission | Global constraint solution across candidate resources and existing wires | Explicit composition graph validation, contract checks, conflict checks, and cycle refusal |
| Ordering | Wiring is solved first; lifecycle/start-level policies govern activation | Deterministic topological order with stable tie-breaks |
| Type consistency | Java package class-space consistency, including uses | Opaque module payloads and explicit contracts; no shared Java class space |
| Update model | New revisions coexist with old in-use wiring until refresh | Exact-version composition profiles; no in-place hot module reload |
| Replacement impact | Refresh may stop and re-resolve a dependent closure | No equivalent transitive refresh or atomic replacement contract is implemented |
| State and saves | Application/framework-specific lifecycle and storage concerns | Module-owned JSON save slices with host-controlled capture/restore lane |
| Isolation | Bundles share the JVM; class loaders are not a security sandbox | In-process trusted code versus isolated WebAssembly backend |

### 8.1 Why CGP should not copy the OSGi resolver wholesale

CGP's current problem is narrower than OSGi's package-space problem. The composition caller already chooses the packages and exact versions. The host validates their manifests, capability requirements, Slot connections, contract versions, cycles, and ordering. Ambiguity is refused rather than resolved through a best-match policy.

A general backtracking requirement/capability solver would add complexity without a demonstrated need if CGP continues to compose a bounded, caller-selected package set with explicit provider identity.

This may change if CGP later gains a package catalog that must solve transitive version constraints across many candidate packages, multiple runtime targets, typed WIT dependencies, or optional feature sets. That would justify a separate package-resolution layer, not necessarily a rewrite of runtime composition.

### 8.2 Why CGP should not copy refresh semantics without a lifecycle design

CGP's current documentation says hot module reloading is not implemented. OSGi demonstrates that a correct replacement mechanism is not simply “load the new module and swap a function reference.”

A replacement protocol would have to define at least:

- which dependent modules are affected by a provider revision;
- whether the old composition remains callable while the new one is prepared;
- how in-flight calls and acquired handles are drained or retired;
- when new dispatch begins using the replacement;
- how module-owned state is migrated or rejected;
- how save capture is serialized against replacement;
- what happens when a replacement module fails initialization;
- whether failure preserves the old composition intact;
- how stale handles and cross-composition references are refused;
- how deterministic simulation steps behave during the transition.

Until those answers exist, the current no-hot-reload boundary is safer than an implicit partial replacement model.

## 9. Transferable lessons

1. **Keep candidate discovery separate from solving.** If a future CGP package resolver is needed, define the candidate catalog, trust filters, version policy, and solver as distinct responsibilities.
2. **Retain immutable composition snapshots.** A resolved composition should have a stable identity and provider mapping. New package availability should not silently rewire an active simulation.
3. **Improve conflict-path diagnostics before adding solver sophistication.** Report the requirement, considered candidates, rejection reason, dependent modules, and conflict category. Avoid claiming a minimal conflict set without computing one.
4. **Treat provider revision retirement as a lifecycle operation.** An old provider may still be referenced by consumers or in-flight calls. Define leases or snapshot lifetime before unloading it.
5. **Make replacement closure explicit.** A provider change can affect every consumer that depends on its contract, including transitive consumers. Compute this closure before attempting replacement.
6. **Separate prepare from publish.** A future replacement feature should ideally prepare and validate a new composition without exposing it, then publish a complete new snapshot only after it passes gates.
7. **Keep save and simulation authority host-owned.** Replacement must not allow partially migrated module state or asynchronous completion to bypass the existing operation lane and commit rules.
8. **Do not treat typed ABI compatibility as behavioral compatibility.** WIT or another IDL can prove interface-shape compatibility, not semantic equivalence, determinism, state migration correctness, or safe lifecycle behavior.

## 10. Suggested CGP conformance tests if package resolution or replacement is pursued

These are future test proposals, not claims about currently implemented CGP behavior.

| Test | Required property |
|---|---|
| Two compatible candidates satisfy one unpinned requirement | CGP applies its documented ambiguity refusal, not an accidental “first package wins” rule |
| Requirement is pinned to a module ID | Only that provider can satisfy the connection |
| Package input order is permuted | The admitted composition and fingerprint remain deterministic |
| One provider's contract changes incompatibly | Composition fails before module initialization |
| A provider is replaced while consumers exist | The affected transitive consumer closure is computed explicitly |
| Old composition receives an in-flight call during preparation | It follows the documented old-snapshot policy and cannot observe mixed providers |
| New composition initialization fails | The old published composition remains intact, if atomic replacement is the chosen contract |
| New composition is published | No dispatch mixes old and new provider revisions |
| Old handles are used after retirement | They fail with a specific stale/closed-composition diagnostic |
| Save capture overlaps replacement | It observes one documented composition generation, not a mixed set of slices |
| State migration fails | The replacement is refused or rolled back without corrupting the old durable state |
| Replacement races with a simulation step | The step commits under one defined composition generation |
| Candidate resolution contains a transitive conflict | The diagnostic identifies the dependency path and conflicting candidates |
| Resolution is cancelled or exceeds a configured budget | No partially published composition or leaked reservation remains |

## 11. Open questions

- Does CGP need a separate package planner, or will explicit profile pins remain sufficient for its intended distribution model?
- If a planner is eventually needed, should it resolve packages before runtime composition and emit a fully pinned lockfile?
- What exact constraints should the planner solve: version ranges, capability cardinality, platform targets, optional features, interface package versions, or all of these?
- Should a future hot-replacement operation affect one module, a Slot owner plus its consumers, or an entire composition generation?
- Would a new composition be built beside the old one and atomically published, or should CGP support draining and replacing modules in place?
- What lease or in-flight-call semantics are required before the old generation can be released?
- How should module-owned save slices migrate across versions, and what must happen when a migration is missing or fails?
- Can WIT package validation catch the transitive typed-interface conflicts CGP actually encounters without importing Java class-space semantics?
- Which diagnostics are essential for an author to repair a failed composition without requiring the full internal solver trace?

## Conclusion

OSGi's resolver and refresh machinery solve problems that become important when a runtime manages a large, changing population of modules. Its requirement/capability resolver finds globally consistent wiring; its uses constraints preserve Java package identity; and its refresh process manages old revisions through the dependent closure.

The strongest lesson for CGP is not to become OSGi. It is to preserve the distinction between package selection, graph validation, runtime wiring, and revision lifecycle. CGP's current exact-version profiles and explicit composition rules remain appropriate for the current prototype. If CGP later needs a package planner or hot replacement, those should be introduced as separately specified capabilities with immutable snapshots, observable failure states, controlled retirement, and deterministic state authority.

**No CGP implementation code or ADR was changed as part of this study.**
