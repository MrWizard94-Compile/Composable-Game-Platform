# OSGi Study 002 — Declarative Services, Dynamic Binding, and Concurrency

**Research date:** 2026-11-15  
**Normative baseline:** [OSGi Compendium Release 8 — Declarative Services 1.5](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)  
**Core service model:** [OSGi Core Release 8 — Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html)  
**Implementation examined:** [Apache Felix Declarative Services](https://github.com/apache/felix-dev/tree/master/scr)  
**Felix source revision:** [286739e356c69badf698f0f735b30607bec4f25e](https://github.com/apache/felix-dev/commit/286739e356c69badf698f0f735b30607bec4f25e)  
**CGP comparison baseline:** [8d28d79bbb85e8071d04645bd995e219c2ab6d02](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/8d28d79bbb85e8071d04645bd995e219c2ab6d02)

## Purpose and evidence boundary

OSGi Study 001 covered the broad bundle/service model. This slice goes deeper into Declarative Services (DS): reference cardinality, static/dynamic policy, greedy/reluctant rebinding, service scopes, component activation/deactivation, thread-safety requirements, and how an implementation processes service churn.

The normative statements come from DS 1.5 and Core Release 8. Apache Felix SCR is one implementation, not the specification. Its executor, locking, tracking, and tests are implementation evidence only. They must not be generalized to every SCR implementation.

This is comparative research, not an implementation decision. No CGP runtime or API changes are authorized by these notes.

## Primary sources

### Specifications
- [Declarative Services 1.5 — OSGi Compendium 8](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)
- [Core Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html)
- [Core Lifecycle Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.lifecycle.html)

### Apache Felix SCR at pinned revision
- [ComponentActorExecutor.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/ComponentActorExecutor.java)
- [Activator.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/Activator.java)
- [ComponentRegistry.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/ComponentRegistry.java)
- [AbstractComponentManager.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/manager/AbstractComponentManager.java)
- [DependencyManager.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/manager/DependencyManager.java)
- [ServiceTracker.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/main/java/org/apache/felix/scr/impl/manager/ServiceTracker.java)
- [ComponentConcurrencyTest.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/test/java/org/apache/felix/scr/integration/ComponentConcurrencyTest.java)
- [ServiceBindGreedyTest.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/test/java/org/apache/felix/scr/integration/ServiceBindGreedyTest.java)
- [ServiceChangedTest.java](https://github.com/apache/felix-dev/blob/286739e356c69badf698f0f735b30607bec4f25e/scr/src/test/java/org/apache/felix/scr/integration/ServiceChangedTest.java)

## Executive findings

1. **DS turns service dependencies into component activation conditions.** A component configuration is satisfied only when its declared references meet their cardinality and target-filter constraints. If an activated configuration becomes unsatisfied, it must be deactivated.
2. **Cardinality describes both optionality and multiplicity.** The four standard forms are 0..1, 1..1, 0..n, and 1..n. For unary references, the service registry's ranking order selects the one bound service.
3. **Static and dynamic references make fundamentally different lifecycle promises.** Static references hide service churn by deactivating the component before a bound service becomes unavailable, then possibly creating a new active component. Dynamic references preserve the component instance and notify/rebind it while active.
4. **Dynamic means concurrent, not merely “automatic.”** The specification says service changes can occur on any thread after component creation. Dynamic components must safely handle bind, updated, and unbind callbacks or field replacement while their own service methods may be executing.
5. **A dynamic replacement can bind the new service before unbinding the old one.** Consumers must not assume a simple unbind-then-bind sequence or treat callback order as a transaction.
6. **Greedy and reluctant policies trade stability for freshness.** Reluctant avoids rebinding a unary reference merely because a better-ranked provider appears. Greedy prefers the better provider and may replace the binding or reactivate the component depending on static/dynamic policy.
7. **Field injection has explicit memory-visibility requirements.** For dynamic replace-style field injection, the field must be volatile. For dynamic multiple references, SCR can replace the collection or update it; a consumer must still choose a concurrency-safe way to use that collection.
8. **Service scope and reference scope are separate controls.** A service may be singleton, bundle, or prototype; a DS reference may request bundle, prototype, or prototype_required semantics. The SCR must track and release acquired service objects when bindings end.
9. **Apache Felix uses a dedicated single-thread component actor executor for selected SCR management work, but that does not make every callback or application service call globally serial.** Its ServiceTracker explicitly documents that serviceChanged must not be synchronized to avoid deadlock potential; dependency managers also use component state/activation locks.
10. **Felix's tests exercise actual service churn and concurrency.** The greedy-binding tests include parallel registration of 1,000 services and verify provider selection; other tests exercise component factory activation and reference changes. This is a useful test model for CGP even though the runtime architecture differs.

## 1. Component satisfaction and cardinality

A DS component description declares references to services. Each reference has:
- An interface type.
- An optional target filter over service properties.
- A cardinality.
- A reference policy (static or dynamic).
- A policy option (reluctant or greedy).
- A reference scope and injection strategy.

The four common cardinalities are:

| Cardinality | Meaning | Component may be active with zero matching services? |
|---|---|---:|
| `0..1` | Optional unary | Yes |
| `1..1` | Mandatory unary | No |
| `0..n` | Optional multiple | Yes |
| `1..n` | Mandatory multiple | No |

Cardinality is not just a count. The upper bound determines whether the implementation is written to handle one or many bound services. The lower bound determines whether the component can be satisfied without a provider. A minimum-cardinality configuration can raise the minimum for multiple references.

If the required cardinality is no longer met, the component configuration becomes unsatisfied and must be deactivated. For unary references with multiple candidate services, the service with the highest registry ranking is selected; tie-breaking follows the ServiceReference ordering.

**CGP distinction:** CGP's service Slot is currently a single-provider contract and refuses ambiguity. Its registry/pipeline/subscriber kinds have separate multiplicity semantics. DS's cardinality system is richer, but a CGP Slot should not silently inherit service ranking and provider replacement unless its contract explicitly calls for it.

## 2. Static versus dynamic reference policy

### 2.1 Static policy

Static is the default and simplest policy. The component receives its initial bound services before activation and does not see subsequent service churn while active.

When a bound static service becomes unavailable, SCR deactivates the component configuration before that service becomes unavailable to the component. If a replacement provider is available, SCR can create/reactivate the component configuration with the replacement binding.

Advantages:
- Component code can treat references as stable during its active lifetime.
- Constructor injection and ordinary non-volatile fields are suitable for static references.
- Service replacement is expressed as component lifecycle replacement, not mutation of a live reference.

Costs:
- Frequent provider churn can repeatedly deactivate and reactivate components.
- Activation may allocate resources, open connections, register services, or rebuild internal state.
- A component with expensive startup can become unavailable or churn heavily.

Greedy static references can also reactivate when a better-ranked service appears, even if the current provider remains available.

### 2.2 Dynamic policy

Dynamic references allow SCR to change the bound service set without deactivating the component configuration. The implementation must handle changes on any thread at any time after instance creation.

With method injection, SCR calls bind, updated, and unbind methods. With field injection, SCR updates the field or collection. With lookup, the component should look up the current bound service when needed rather than retaining a stale service object.

A critical ordering detail: for a dynamic replacement, the new service's bind method may be called before the old service's unbind method. The component can temporarily observe both during transition. This is not a two-phase transaction and should not be treated as atomic replacement.

Advantages:
- The component instance can remain alive through provider changes.
- Useful for optional services and collections of providers.
- Avoids repeated activation costs for frequent changes.

Costs:
- Component code must handle concurrent changes and service methods.
- Callback order can be nontrivial.
- A stale service reference can outlive its registry membership unless the component updates its own references correctly.
- The implementation must define what a concurrent call observes during replacement.

### 2.3 Greedy versus reluctant

The policy option controls whether a newly available better-ranked service causes rebinding.

| Reference | Reluctant | Greedy |
|---|---|---|
| Static unary | Keep current binding | Reactivate to use better provider |
| Dynamic unary | Keep current binding unless none bound | Unbind old and bind better provider |
| Dynamic multiple | Bind newly matching services | Bind newly matching services |
| Static multiple | Generally not applicable | Reactivate behavior is defined, but static multiple is not the normal pattern |

Reluctant reduces churn. Greedy prioritizes provider ranking. Neither is universally superior: a stable provider may be more valuable than a marginally higher-ranked one, while some systems genuinely need the best available provider.

## 3. Injection strategy and concurrency contract

DS supports method injection, field injection, constructor injection, and lookup.

### Method injection

Bind/unbind methods make provider changes explicit, but the component must manage its own state. A robust component may need a concurrent collection, a lock, immutable snapshots, or a short critical section. It must also be prepared for a new provider to bind before the old provider unbinds.

### Field injection

For a dynamic unary reference using replace semantics, the field must be volatile so that updates made by SCR are visible to component threads. For dynamic multiple references, SCR can replace a collection with an updated snapshot; the collection type and update option have constraints.

A volatile reference to a collection does not automatically make mutations inside an arbitrary mutable collection thread-safe. The component must not infer more safety than the specification promises.

### Constructor injection

Constructor injection provides the initial bound services during component construction. It naturally fits references that are static for the lifetime of the component. A component cannot use constructor injection to handle future dynamic provider changes without another notification/lookup mechanism.

### Lookup strategy

The ComponentContext lookup strategy can retrieve currently bound services by reference name. For dynamic references, the specification warns against storing the returned service objects; look them up when needed so the component does not retain a stale binding.

**CGP transfer:** if CGP ever adds hot-swappable Slot providers, prefer an immutable dispatch snapshot or explicit lease over injecting a mutable provider reference into arbitrary module state. The runtime must decide what happens to calls already in flight when the provider changes.

## 4. Service scope and resource release

Core OSGi service scope determines how service objects are created for consumers:
- Singleton: same service object shared.
- Bundle: ServiceFactory customizes one service object per using bundle.
- Prototype: PrototypeServiceFactory can create distinct objects per request.

DS reference scope adds component-level behavior:
- Bundle: component instances in one bundle use the same object for a bound service.
- Prototype: component instances may receive distinct objects.
- Prototype-required: each component instance must receive a distinct service object and only prototype-scoped providers qualify.

When a service becomes unbound, SCR must release the service objects it acquired. For prototype scopes, SCR tracks objects obtained through ServiceObjects and releases unreleased objects when the binding ends.

This is a useful ownership pattern: a service binding is not just a pointer; it carries a resource acquisition and release obligation.

## 5. Component activation and deactivation

A component configuration is created from a component description and properties. It can become satisfied only when enabled and all mandatory references are satisfied. Activation creates the component instance, performs required injections, invokes activation behavior, and registers provided services as appropriate.

Delayed components can defer object creation until their provided service is actually requested. This reduces startup time and memory when the service is never used.

When a component configuration becomes unsatisfied, is disabled, or its bundle stops, SCR deactivates it. It unregisters provided services and releases bound service objects. Component lifecycle is nested within bundle lifecycle: stopping the bundle disables its components.

Activation/deactivation is therefore coupled to external provider availability. A component that uses mandatory static references can be repeatedly destroyed and reconstructed as providers churn.

**Failure point:** activation/deactivation hooks are application code. They may allocate external resources, write files, open sockets, or mutate shared state. The DS framework manages component lifecycle, but that does not automatically make those external effects transactional or reversible if an activation hook fails partway through.

## 6. Apache Felix SCR implementation observations

### 6.1 Dedicated component actor

At the pinned Felix revision, `ComponentActorExecutor` extends `ScheduledThreadPoolExecutor` with a core pool size of one and a daemon thread named `SCR Component Actor`. Its class comment describes it as the thread used to act upon registered components of the service component runtime and to schedule service change-count updates.

The Felix Activator constructs this executor and passes it to ComponentRegistry. The registry submits selected asynchronous tasks to it, including late-binding work. On SCR shutdown, the executor is shut down.

This is an implementation-level serialization mechanism for selected SCR management tasks. It is not evidence that all bundle events, bind/unbind callbacks, service method invocations, or component code execute on that one thread.

### 6.2 Service tracking and deadlock avoidance

Felix's ServiceTracker event callback explicitly states that `serviceChanged` must not be synchronized to avoid deadlock potential. It handles REGISTERED/MODIFIED by tracking and MODIFIED_ENDMATCH/UNREGISTERING by untracking.

Felix's DependencyManager has separate customizers for static/dynamic and unary/multiple behavior. It uses component activation/deactivation methods, tracker state, and component-manager synchronization to respond to reference changes.

The AbstractComponentManager source includes activation and state locks, bounded lock acquisition, and guarded deactivation paths. This is evidence that dynamic service management is a concurrency problem requiring more than one global queue.

### 6.3 Test evidence

The pinned Felix tests include:
- `ServiceBindGreedyTest`: verifies reluctant/greedy behavior, service ranking changes, unregistration, replacement, and multi-threaded registration of 1,000 services.
- `ServiceChangedTest`: verifies target-filter changes, bind/unbind counts, optional and mandatory unary references, and optional multiple references.
- `ComponentConcurrencyTest`: exercises concurrent component activation through component factories and fails on unexpected warnings/errors.

The test names and scenarios are informative: DS correctness is tested under service churn, concurrent registration, reference satisfaction changes, and activation races—not just a static graph at startup.

## 7. CGP comparison and recommendations

Relevant CGP decisions reviewed:
- ADR 0002 — Manifests, Slots, and Resolution
- ADR 0003 — Execution, Trust, and Lifecycle
- ADR 0004 — Ordered Dispatch
- ADR 0005 — Module-Owned Saves
- ADR 0010 — Execution Boundary
- ADR 0012 — Cross-Backend Execution and Aggregate Budgets
- ADR 0016 — Simulation Integrity

### Transferable ideas

1. **Make dependency satisfaction explicit.** If a future CGP module requires a service before activation, express that as a typed requirement with a clear minimum cardinality and failure report.
2. **Distinguish stable from dynamic dependencies.** A dependency that cannot change during a composition should be resolved once. A truly dynamic dependency needs a specific change protocol.
3. **Use leases or explicit handles for provider lifetime.** Acquiring a service object creates an obligation to release it. CGP should define in-flight call behavior before provider replacement.
4. **Preserve provider snapshots during dispatch.** A dispatch should not observe half of an old provider set and half of a new one unless the contract explicitly permits it.
5. **Test churn and concurrency.** Add adversarial tests for provider add/remove/modify during dispatch, registration storms, provider failures, shutdown races, and save capture.
6. **Keep lifecycle hooks out of arbitrary concurrent mutation paths.** A narrow management lane can serialize structural changes while data-plane calls continue under a defined snapshot/lease policy.

### What not to copy automatically

- A continuously changing shared registry for every CGP composition.
- Automatic provider rebinding while a deterministic simulation step is open.
- Component callbacks on arbitrary threads without an explicit CGP threading contract.
- Treating a volatile pointer as a complete concurrency or ownership solution.
- Assuming a dedicated management thread eliminates deadlocks or all races.
- Coupling CGP module activation to service arrival unless the module contract explicitly requires it.

## 8. Suggested CGP tests inspired by this slice

| Test | Expected property |
|---|---|
| Provider removed while dispatch is in progress | In-flight call completes against its admitted provider snapshot or is explicitly cancelled |
| Better-ranked provider appears during dispatch | Current dispatch does not silently switch providers |
| Provider is removed and re-added rapidly | No duplicate registration, leaked lease, or stale handle |
| Dynamic service changes during save capture | Capture sees a defined composition cut; no mixed provider generation |
| Required provider disappears | Composition/module enters an explicit refused or quiescing state |
| Optional provider disappears | Existing contract defines whether dispatch omits, refuses, or uses a fallback |
| Multiple providers change concurrently | Ordering is deterministic and not based on event arrival races |
| Shutdown races with bind/unbind | Every acquired resource is released exactly once |
| Callback blocks or deadlocks | Management operations have bounded waiting and diagnostic evidence |
| 1,000 concurrent registrations | Resolver/registry remains correct and does not leak or duplicate entries |

## 9. Open questions

- Should CGP's future dynamic module replacement use a two-phase quiesce-and-swap protocol, or should provider sets be immutable for each composition?
- What is the desired behavior for a provider removed while a guest call is executing: drain, cancel, or allow the old instance to finish?
- Should CGP expose service leases to modules, or keep all provider invocation behind host dispatch?
- What diagnostic structure best explains why a required dependency became unsatisfied?
- Is a separate structural-management executor useful for CGP, or does the current caller-driven lane already provide the necessary serialization?

## Conclusion

Declarative Services shows how a mature modular runtime can make service dependency management far easier for authors—but it does not make dynamic service churn disappear. It moves the complexity into explicit cardinality, binding policies, activation/deactivation, concurrent callbacks, service-object lifetimes, and runtime coordination.

For CGP, the most valuable lesson is to make provider lifetime and replacement semantics explicit before adding hot reload or dynamic module replacement. A composition-scoped provider snapshot with controlled leases may fit CGP better than OSGi's continuously changing service registry, while still borrowing DS's strong dependency diagnostics and test discipline.
