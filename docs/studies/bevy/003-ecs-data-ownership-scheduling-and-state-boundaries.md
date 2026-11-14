# Bevy Study 003 — ECS Data Ownership, Scheduling Guarantees, and State Boundaries

**Research date:** 2026-11-14  
**External project:** Bevy  
**Upstream source revision inspected:** [7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a) (main; workspace version 0.20.0-dev)  
**CGP comparison baseline:** [1639cf969c98af03f398dfbabaa34d5ee7a4ab90](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/1639cf969c98af03f398dfbabaa34d5ee7a4ab90)

## Purpose

Examine how Bevy describes system data access, prevents conflicting concurrent access, stages structural mutations, tracks data changes, and executes schedules. Compare those guarantees with CGP's module-owned state, caller-driven simulation steps, proposal pipeline, mutation lane, and authoritative ledger.

This is a research note, not an implementation decision. It does not authorize adding an ECS to CGP or changing CGP's execution, state, or simulation contracts.

## Executive findings

1. **Bevy systems declare data access through typed parameters.** Resource/component read and write access is collected as system metadata. The scheduler uses that metadata to prevent conflicting systems from running simultaneously. This is an in-process concurrency mechanism, not a module authorization or transaction system.
2. **Access conflicts constrain concurrency, not all ordering.** Explicit before/after edges define required order. Compatible systems may run in parallel. Conflicting systems without an ordering relationship are reported as scheduling ambiguities; a conflict does not itself define a semantically meaningful deterministic order.
3. **The multithreaded executor is not a deterministic sequential pipeline.** It starts ready non-conflicting systems concurrently and advances dependents as predecessors finish. Bevy explicitly documents that multithreaded execution can produce orderings that are not possible in the single-threaded executor for a given topological graph sort.
4. **Commands defer structural World changes.** Systems enqueue commands; ApplyDeferred later applies them. Bevy can insert synchronization points on dependency edges so a dependent system sees deferred changes from its predecessor. This is a useful phase-boundary pattern, but queued commands are trusted imperative World mutations—not validated proposals with an all-or-nothing authoritative commit.
5. **Change detection is tick-based invalidation, not semantic diffing or an event log.** Mutable dereference marks data changed even if the value is written back unchanged. Interior mutability requires explicit marking. Tick aging/wraparound is managed, and changes eventually expire from detection.
6. **CGP already has stronger, domain-specific authority for its current simulation proof.** Systems return proposals from snapshots; the ledger validates the open step, next tick, entity set, and coordinate range; the runner controls commit and completion publication.
7. **The best transferable ideas are explicit read/write declarations, conflict diagnostics, named synchronization boundaries, and test-time schedule perturbation.** These are relevant only if CGP later adds a general-purpose system scheduler.

## 1. Evidence boundary and inspected sources

The study pins Bevy source revision 7ea4827e16d5d50d48e22d9a249c554ad073f38a. Relevant primary source files:

- [System parameters and access validation](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/system/system_param.rs)
- [System access metadata](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/system/system_meta.rs)
- [Schedule graph, build settings, and ambiguity checks](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/schedule.rs)
- [Schedule executors](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/executor/mod.rs)
- [Multithreaded executor](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/executor/multi_threaded.rs)
- [Single-threaded executor](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/executor/single_threaded.rs)
- [Deferred command queue](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/system/commands/mod.rs)
- [Automatic deferred synchronization pass](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/schedule/auto_insert_apply_deferred.rs)
- [Change detection traits](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/change_detection/traits.rs)
- [Change detection ticks](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/change_detection/tick.rs)
- [Change detection module and age limits](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_ecs/src/change_detection/mod.rs)

The study distinguishes guarantees documented by Bevy from architectural conclusions for CGP. An implementation detail at this revision should not be assumed to be a permanent API guarantee.

## 2. Typed access declarations and conflict detection

### 2.1 System parameters describe access

Bevy systems are functions whose parameters implement SystemParam. Common examples include Res<T> for shared resource access, ResMut<T> for mutable resource access, queries with shared or mutable component references, Commands for deferred structural changes, and Local<T> for state retained by a system parameter instance rather than stored as a World resource.

Each parameter contributes access metadata when the system is initialized. The access model can identify particular resource/component types and filtered query access. Disjoint queries can be proven compatible using filters such as With<T> and Without<T>; overlapping mutable access is rejected during parameter validation unless safely structured, for example through ParamSet.

This metadata is part of the safety contract that permits the executor to expose multiple views of one World concurrently. The executor's unsafe World access is justified by registered system access sets and scheduler conflict checks. That safety depends on systems accurately declaring access through the supported parameter model.

### 2.2 What conflicts mean

Two systems with compatible access can run concurrently. Shared reads can coexist. Mutable access conflicts with another access to the same data where aliasing would be unsafe.

Bevy distinguishes access conflicts (whether systems can safely access World data at the same time), ordering dependencies (whether one system must run before another), and scheduling ambiguities (conflicting systems not ordered by the graph and therefore potentially observing different interleavings).

The scheduler can report ambiguities as warnings or errors. It also supports explicit ambiguity exemptions. An exemption suppresses a diagnostic; it does not add an ordering edge or make a race deterministic.

For CGP, “these operations cannot overlap” is not the same contract as “operation A must precede operation B.” A host that needs stable outcomes must define both concurrency compatibility and semantic order.

### 2.3 Boundary of the guarantee

Bevy's access metadata governs access through the ECS system interface. It does not automatically govern static/global state, files, sockets, databases, third-party libraries with hidden side effects, incorrectly declared interior-mutability structures, or module-private state outside the World.

It is not a security boundary between independently authored packages. Bevy plugins and systems execute as trusted Rust code in the host process. Do not confuse ECS access metadata with CGP's isolated WebAssembly guest boundary or capability policy.

## 3. Scheduling: partial order is not deterministic simulation

### 3.1 Explicit dependencies

Bevy systems and system sets can be configured with before/after relationships and chained configurations. These constraints form a directed scheduling graph. The graph builder checks invalid cycles and related graph inconsistencies, then computes an executable topological representation.

The graph is a partial order. If A must precede B, that edge constrains them. If C and D are independent and access-compatible, the graph does not require a particular relative order.

A deterministic topological sort chosen by one build is not the same as a deterministic execution trace under every executor. The multithreaded executor starts ready systems when dependencies and access conflicts permit. Completion timing affects when dependents become ready. Systems may therefore execute in different valid interleavings.

Bevy's schedule-build documentation explicitly warns that the multithreaded executor can produce orderings that are not possible in single-threaded execution for a provided topographic graph sort. Its optional shuffle seed can perturb valid orderings during development to expose missing constraints. The documentation recommends considering the single-threaded executor when using this diagnostic because multithreaded execution adds further interleavings.

### 3.2 Executor guarantees and limits

The executor guarantees that explicit dependency constraints are respected, systems with incompatible access are not run concurrently, non-conflicting ready systems may run concurrently, and deferred buffers are applied at configured synchronization points.

It does not guarantee one universal order among all independent systems, deterministic completion timing, deterministic outcomes for systems communicating through untracked external state, equivalence between all single-threaded and multithreaded traces, or a transaction across all systems in one schedule.

If independent systems mutate separate resources, concurrency may be safe and outcome-equivalent. If they communicate through side effects, shared external state, or ordering-sensitive output, missing dependencies can become observable. An access-safe schedule is not automatically replay-stable.

### 3.3 CGP implication

CGP's current simulation pipeline deliberately orders contributions by (order, module id, contribution id). It folds each proposal into the next pipeline value, stops on failure, validates the final proposal, and commits through the ledger. This is a semantic order, not merely a race-avoidance graph.

Replacing that with a general parallel scheduler would require separate definitions for commutativity, snapshot versus intermediate reads, conflict resolution, deterministic result ordering, error/cancellation behavior, replay records, and equivalence across worker counts, runtimes, and platforms. Without those rules, parallelizing “compatible” systems would weaken the current proof.

## 4. Deferred commands and synchronization points

### 4.1 Why Bevy defers structural changes

Bevy's Commands parameter writes commands into a deferred queue. Commands can spawn/despawn entities, insert components/resources, or run custom command implementations against a mutable World when applied.

Deferring structural changes avoids mutating ECS structures while other systems may be iterating or holding component access. The system records intent in a command buffer; the executor later applies the buffer at an ApplyDeferred synchronization point.

The command queue is not itself a validated transaction. A queued command is trusted imperative code that receives mutable World access when applied. Commands can fail, and the configured error handler determines how failures are handled. There is no general rollback of earlier commands in the buffer if a later command fails.

### 4.2 Automatic synchronization on dependency edges

Bevy's automatic deferred-application pass inserts ApplyDeferred nodes where a system with deferred buffers has an ordering dependency leading to another system. This allows a dependent system to observe structural changes from its predecessor. The pass can be disabled, and explicit synchronization behavior can be configured.

The executor also supports applying final deferred buffers after systems finish. Deferred application follows the schedule's topological order; buffers are only guaranteed to be applied before another system's buffers when an explicit ordering exists between those systems.

This is a useful pattern: synchronization boundaries should be explicit and placed where consumers require visibility, rather than flushing every buffer after every system.

### 4.3 CGP comparison

CGP's simulation system avoids exposing direct authoritative state mutation to pipeline contributors. A system receives a snapshot and returns a proposal. The host/runner validates and commits the accepted final result through the ledger. The lane also serializes the step with save/restore and mutating service operations.

Bevy's deferred commands solve a different problem: safely scheduling imperative structural changes to a shared ECS World. CGP's proposal boundary provides validation and authority over a domain-specific state transition.

If future CGP systems need to queue non-authoritative work, define a typed command/proposal buffer and an explicit host-owned application phase. Do not expose arbitrary host mutation callbacks as the default command contract. Any command path that can mutate authoritative module state must still pass the module's own validation and CGP's execution policy.

## 5. Change detection: useful invalidation, not a source of truth

### 5.1 Tick semantics

Bevy stores added and changed ticks with components/resources. Systems track their own last-run tick. is_added and is_changed compare data ticks with the system's last-run/current ticks.

Mutable access through Bevy's change-detection smart pointers automatically marks data changed when mutably dereferenced. It does not compare before/after values. Reading does not mark a value changed; obtaining mutable access and writing the same value back can still mark it changed; interior mutation through a cell-like type is not automatically visible unless change detection is manually reported; callers can deliberately bypass change detection, which is documented as risky.

This makes change detection efficient for deciding whether derived work should be reconsidered. It is not a semantic diff, mutation audit log, or proof that a value's contents differ.

### 5.2 Tick wraparound and expiration

Ticks are 32-bit wrapping counters. Bevy compares relative ages and periodically clamps old change ticks to prevent arithmetic overflow and false positives. The source defines a maximum age; once a change becomes older than that bound, change detection no longer reports it as recent.

The clamping logic is designed to keep comparisons stable across wraparound. Nevertheless, this is a bounded invalidation mechanism, not an unbounded historical record. A system that was not run for an extended time cannot rely on change ticks as a permanent record of every intermediate mutation.

### 5.3 CGP implication

CGP's save slices, simulation ledger, and completion events serve different purposes: save slices capture module-owned durable state; the ledger is authoritative for accepted simulation state; completion events announce a committed step; proposal values carry candidate changes.

A future CGP scheduler may benefit from change notifications for cache invalidation or derived data. It should not use a changed bit as proof of a committed mutation, replay record, or substitute for explicit completion events. If notifications are introduced, their lifetime, coalescing, missed-listener behavior, and restore semantics must be specified.

## 6. Data ownership and state boundaries

Bevy's ECS World is a shared application data store. Components are attached to entities; resources are World-scoped singleton data; Local system parameters retain system-local state. The ECS uses Rust types, lifetimes, and runtime access metadata to make concurrent access to that shared World safe.

This differs from CGP's module ownership model: CGP modules own their state and save slices; the Foundation does not interpret module-private state; Slot contracts mediate cross-module interaction; the in-process JavaScript backend is trusted code, not sandboxed; WebAssembly guests are isolated behind a backend and host ABI; and the simulation ledger is authoritative for accepted state in the current simulation proof.

Bevy centralizes data access for ECS convenience and scheduling. CGP intentionally avoids a universal host-owned game World because module ownership and domain-specific authority are platform constraints. An ECS could exist inside a CGP module or a future optional subsystem, but its World should not silently become the Foundation's global state authority.

## 7. Transferable ideas and non-transferable mechanisms

| Bevy mechanism | Possible CGP lesson | Important limit |
|---|---|---|
| Typed read/write system parameters | Explicit access declarations for future scheduled work | Does not authorize module access or sandbox code |
| Access conflict validation | Detect unsafe or ambiguous concurrent work before execution | Conflict freedom does not define semantic order |
| Before/after graph | Explicit partial-order constraints | Partial order alone is not a deterministic total order |
| Schedule ambiguity diagnostics | Make missing ordering constraints visible | Ignoring a warning does not make behavior deterministic |
| Schedule shuffle seed | Test hidden ordering assumptions | Not a production replay mechanism |
| Deferred command buffers | Queue work and apply at explicit synchronization boundaries | Commands are imperative mutations, not transactional proposals |
| Change ticks | Efficient invalidation of derived work | Not semantic diffing, durable history, or commit proof |
| World/Local split | Distinguish shared domain data from system-private scratch | Does not replace CGP module-owned state and save contracts |

## 8. Recommendations for CGP

1. **Keep the current simulation proposal-and-ledger model.** It provides stronger domain-specific validation than a generic ECS access scheduler.
2. **Do not introduce parallel execution until deterministic semantics are specified.** Begin with a serial, explicitly ordered reference executor if a general scheduler becomes necessary.
3. **If parallel scheduling is later added, require explicit read/write declarations.** Treat undeclared access and external side effects as unsafe or trusted-only. Validate conflicts before execution.
4. **Separate conflict constraints from order constraints.** A scheduler must report both; one cannot substitute for the other.
5. **Keep synchronization boundaries named and inspectable.** A deferred buffer needs a documented visibility point, failure policy, and deterministic application order.
6. **Keep authoritative mutations behind module-owned validation and host-controlled commit paths.** Do not treat queued callbacks as safe merely because they execute after systems finish.
7. **Use notifications for invalidation, not history.** Committed events or an explicit event log are required when replay, audit, or recovery needs durable records.
8. **Consider schedule perturbation as a future test technique.** Development-only randomized ordering can expose missing constraints, but should not alter production semantics.

## 9. Open questions

- If CGP adds a scheduler, should it schedule whole module contributions, typed operations within a module, or both?
- Can the platform express pure/read-only work separately from proposal-producing work and authoritative commit operations?
- Should access declarations be enforced only for a trusted native backend, or represented in manifests/contracts for every backend?
- How should a scheduler account for hidden side effects and calls into external services?
- What exact determinism target is required: stable ordering on one runtime, identical results across worker counts, or replay equivalence across Node and browser backends?
- Should change notifications be edge-triggered, level-triggered, coalesced, or sequence-numbered?
- What happens to queued work when a module is disabled, replaced, or shut down?

## 10. Conclusion

Bevy demonstrates a mature approach to safe parallel access over a shared ECS World: typed access declarations, conflict-aware scheduling, explicit ordering, and deferred structural mutation. It also demonstrates why those mechanisms should not be mistaken for deterministic simulation semantics. A safe parallel schedule can still have multiple valid interleavings, and tick-based change detection is not a durable mutation history.

For CGP, the strongest lesson is to make access, ordering, and synchronization explicit if a scheduler is ever needed. The current module-owned state model and proposal/ledger authority should remain intact. Bevy's ECS is a useful optional implementation model inside a module, not a replacement for CGP's Foundation or simulation contract.
