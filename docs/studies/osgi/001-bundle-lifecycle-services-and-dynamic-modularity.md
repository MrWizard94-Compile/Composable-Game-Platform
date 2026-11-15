# OSGi Study 001 — Bundle Lifecycle, Service Registry, Dependency Resolution, and Dynamic Modularity

**Research date:** 2026-11-15  
**Specification baseline:** [OSGi Core Release 8](https://docs.osgi.org/specification/osgi.core/8.0.0/)  
**Companion specification:** [OSGi Compendium Release 8 — Declarative Services 1.5](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/)  
**Implementation examined:** [Eclipse Equinox](https://github.com/eclipse-equinox/equinox)  
**Equinox source revision:** [1200da8f6e7ea3ffa049aaf8ffe9967ba1954327](https://github.com/eclipse-equinox/equinox/commit/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327)  
**CGP comparison baseline:** [37e3191f268d281a4163107f5e5d2498d4a77fa8](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/37e3191f268d281a4163107f5e5d2498d4a77fa8)

## Purpose and evidence boundary

This study examines OSGi as a long-lived, runtime-managed modularity system. It focuses on bundle identity and lifecycle, package/capability resolution, service discovery and binding, dynamic replacement, and the operational complexity those features introduce.

The normative behavior is drawn from OSGi Core Release 8 and Declarative Services 1.5. Implementation observations are drawn from the pinned Equinox source revision. OSGi is a specification with multiple implementations; Equinox-specific internals must not be treated as universal requirements.

This is comparative research, not an implementation decision. It does not authorize replacing CGP's manifest, Slot, profile, execution, persistence, or deterministic simulation contracts.

## Primary sources

### Normative specifications
- [OSGi Core Release 8](https://docs.osgi.org/specification/osgi.core/8.0.0/)
- [Module Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.module.html)
- [Life Cycle Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.lifecycle.html)
- [Service Layer](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.service.html)
- [Resolver Service Specification](https://docs.osgi.org/specification/osgi.core/8.0.0/service.resolver.html)
- [Bundle Wiring API](https://docs.osgi.org/specification/osgi.core/8.0.0/framework.wiring.html)
- [OSGi Compendium Release 8 — Declarative Services](https://docs.osgi.org/specification/osgi.cmpn/8.0.0/service.component.html)

### Pinned Equinox implementation
- [Equinox repository](https://github.com/eclipse-equinox/equinox)
- [ModuleResolver.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/container/ModuleResolver.java)
- [ServiceRegistry.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/internal/serviceregistry/ServiceRegistry.java)
- [ServiceRegistrationImpl.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/internal/serviceregistry/ServiceRegistrationImpl.java)
- [ServiceUse.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/container/src/org/eclipse/osgi/internal/serviceregistry/ServiceUse.java)
- [FrameworkWiring.java](https://github.com/eclipse-equinox/equinox/blob/1200da8f6e7ea3ffa049aaf8ffe9967ba1954327/bundles/org.eclipse.osgi/osgi/src/org/osgi/framework/wiring/FrameworkWiring.java)

## Executive findings

1. **OSGi is a complete runtime modularity framework, not just a plugin loader.** It specifies module metadata, package wiring, lifecycle, services, events, and security-related APIs. Equinox adds a production implementation and optional services.
2. **Bundles are persistent installed units with independently managed lifecycle state.** A framework assigns bundle IDs; bundles can be installed, resolved, started, stopped, updated, refreshed, and uninstalled. Persistent autostart intent can survive framework restarts.
3. **Dependency resolution is richer than a simple topological sort.** OSGi uses a generic Requirement-Capability model with attributes, filters, namespaces, versions, transitive constraints, existing wiring, and package `uses` consistency. The Resolver service returns a wiring delta or a resolution failure.
4. **Package wiring and service binding are distinct dependency systems.** Package imports establish class-space relationships; the service registry provides runtime object discovery and binding. One is not a substitute for the other.
5. **The service registry is intentionally dynamic.** Services can appear, change properties, and disappear while consumers run. Consumers must react to service events and release acquired objects. OSGi explicitly warns that stale Java object references can retain stopped bundle class loaders and memory.
6. **Declarative Services exists partly because dynamic service management is hard to write correctly.** It automates component activation, dependency binding, and deactivation, with static and dynamic reference policies. Dynamic references may change on any thread while a component remains active.
7. **Update is not immediate global replacement.** An updated bundle can have a new current revision while old in-use wiring remains available until refresh. Refresh computes a dependency closure, stops affected bundles, removes obsolete wiring, and restarts eligible bundles.
8. **OSGi lifecycle and service state are not inherently transactional across an application graph.** The framework defines operation-specific guarantees, events, and cleanup, but a multi-bundle update/refresh can stop and restart multiple participants and may leave some unresolved if dependencies are no longer available.
9. **OSGi bundles share a JVM process.** Separate class loaders and framework-managed visibility are not equivalent to OS-process or Wasm isolation. A bundle executing arbitrary Java code is not made safe merely by being a bundle.
10. **OSGi is a strong reference for runtime install/update, service discovery, dependency metadata, and diagnostics—not a replacement for CGP's composition authority.** CGP intentionally uses caller-selected immutable profiles, explicit contribution ordering, backend isolation, and host-owned mutation lanes.

## 1. Bundle model and identity

An OSGi bundle is normally a JAR with manifest metadata. The manifest declares identity and version information, package exports/imports, generic capabilities and requirements, execution-environment constraints, and other directives. The framework installs the bundle and creates a Bundle object that manages its lifecycle.

Bundle identity has several dimensions:
- A framework-assigned numeric bundle ID, unique within that framework and retained for that installed bundle across update and framework restart.
- A symbolic name and version declared by the bundle.
- A bundle location assigned by the installer/management agent.
- A specific bundle revision and its wiring, which can change as the bundle is updated.

Uninstalling and reinstalling creates a new bundle identity. Updating a bundle keeps its bundle identity but introduces a new revision. This distinction is important: stable logical identity does not mean the underlying executable revision and package wiring are unchanged.

The framework must install a bundle persistently and atomically: a failed installation must leave the framework in the prior state. Installed bundles remain until explicitly uninstalled. Whether a bundle is persistently marked started or stopped is also retained by the framework.

**CGP comparison:** CGP's package catalog and profile selection currently choose exact module IDs and versions for a composition. OSGi's persistent framework inventory is a different operational model: installed bundles exist independently of any one application composition, and the framework can alter their lifecycle over time.

## 2. Dependency resolution: requirements, capabilities, and wiring

### 2.1 Generic Requirement-Capability model

OSGi does not limit dependency declarations to package names. A resource can declare:
- A **capability**: a named namespace plus attributes/directives describing what it provides.
- A **requirement**: a constraint, usually expressed as a filter over capability attributes in a namespace.

The resolver finds a consistent set of wires connecting requirements to capabilities. It considers transitive requirements: a candidate provider may itself require other resources. All mandatory requirements of the requested resources must be satisfied, or resolution fails.

The model supports package wiring, bundle identity, execution environments, native environments, and generic custom namespaces. This makes it more expressive than a plain module-ID dependency list.

### 2.2 Constraint solving and class-space consistency

The resolver must account for existing framework wiring, not just the newly requested bundle set. OSGi package `uses` constraints are especially important: if an exported package's API exposes types from another package, the importing bundles must see a consistent class space for those types. Otherwise two classes with the same binary name but different defining class loaders can be incompatible.

The Resolver service specification explicitly notes that resolving transitive dependencies is NP-complete in the general case. It is designed to return a consistent set of resource wires, report resolution failures, and support tooling such as provisioning and diagnostics.

A useful division of responsibility:
- The Resolver solves the wiring constraints.
- The ResolveContext supplies the environment, existing wiring, candidate capabilities, policy, and matching context.
- The framework applies the resulting wiring to its runtime module state.

The Resolver service itself is described as a low-level system-developer API, not an ordinary application API.

### 2.3 Dynamic resolution

OSGi also supports dynamic package imports. A bundle can have an unresolved dynamic requirement that is resolved when a matching class is first requested. Dynamic resolution can pull in additional resources and add wires to existing wiring.

This is powerful but makes the runtime graph less static: a bundle's effective package wiring can grow during execution.

### 2.4 Equinox implementation observation

The pinned Equinox `ModuleResolver` delegates constraint solving to the Apache Felix Resolver implementation and translates the resulting resource wires into Equinox ModuleWiring structures. It contains explicit handling for dynamic requirements and maintains the distinction between required and provided wires.

This is evidence of Equinox's implementation strategy at the pinned revision, not a requirement that all OSGi frameworks use Apache Felix Resolver internally.

**CGP comparison:** CGP ADR 0002 uses explicit capability requirements, optional requirements, module pins, deterministic topological ordering, and refusal on ambiguity/cycles. OSGi offers more expressive package-space and generic capability resolution, but does not imply CGP should adopt runtime class loading or allow resolution to change silently during a deterministic simulation.

## 3. Bundle lifecycle and dynamic replacement

### 3.1 Lifecycle states

The core bundle states are:
- `INSTALLED`: installed but not yet resolved.
- `RESOLVED`: mandatory dependencies are resolved and the bundle can be started.
- `STARTING`: activation is in progress.
- `ACTIVE`: activation completed successfully.
- `STOPPING`: deactivation is in progress.
- `UNINSTALLED`: permanently removed from the framework's installed set.

A bundle is started through its Bundle object or framework autostart policy. The framework invokes the declared BundleActivator's `start` and `stop` methods when activation/deactivation is required. Lazy activation can defer actual activation until code is first used.

A BundleContext provides the bundle's view into framework information, lifecycle operations, and service registration/discovery. The system bundle represents the framework itself.

### 3.2 Persistent start intent and framework restart

The framework records whether a bundle should be started automatically. A bundle marked persistently started is started again when the framework starts, subject to readiness and optional start-level policy. Transient start/stop operations do not rewrite persistent autostart intent.

This is a platform-managed deployment/runtime policy. It differs from CGP's caller-driven execution, where a composition is explicitly opened and dispatched by its caller.

### 3.3 Stop cleanup

When a bundle stops, the framework automatically unregisters its services and framework listeners. The BundleActivator instance whose `start` completed successfully must receive its corresponding `stop` call when deactivated and must not be reused afterward.

However, stopping a bundle does not instantly make every class from it unreachable. The specification notes that packages exported by a stopped bundle can remain available to other bundles, and other bundles may still execute code from that bundle. This is one reason service and class-space lifecycle cannot be reduced to “stop equals unload.”

### 3.4 Update and refresh

Updating a bundle introduces a new revision. New capabilities become available to future resolution, but if the old revision still has in-use wiring, its capabilities remain available to existing bundles and future resolves until refresh or framework restart.

The framework's refresh operation is broader than replacing one JAR:
1. Compute the dependency closure of the target/removal-pending bundles.
2. Stop active bundles in that closure.
3. Unresolve resolved bundles in the closure.
4. Remove uninstalled bundles from the closure and framework storage.
5. Restart bundles that were active before refresh, causing their dependencies to resolve again.

The refresh operation runs asynchronously and reports errors through framework events. If dependencies have changed or disappeared, some bundles may fail to resolve on restart.

**Failure point:** hot replacement is not an atomic swap of a single live object graph. Existing consumers may retain old wiring until refresh, while refresh can stop and restart a dependency closure. Application-level state migration and compatibility still require deliberate design.

### 3.5 Lifecycle events and observability

The framework publishes bundle and framework events for state changes, errors, resolution, update, uninstallation, and package refresh. These events are a key part of operating and diagnosing a dynamic system. Event delivery timing matters: for example, the UNRESOLVED event for a refresh set is published after all affected bundles have been stopped and before eligible bundles restart.

## 4. Service registry: publish, find, bind

### 4.1 Service objects and references

An OSGi service is a Java object registered under one or more interface names, together with properties. A service reference exposes metadata but not the service object itself. A consumer obtains the service object through its BundleContext.

This separation allows bundles to discover and inspect candidates without acquiring the object. Filters can query service properties, and service events notify consumers about registration, modification, and unregistration.

The service registry is not the package resolver:
- Package wiring determines which class definitions a bundle imports/exports.
- The service registry discovers runtime objects implementing interfaces that are visible to the consumer.

### 4.2 Service properties and selection

Services are registered with interface names and metadata properties. Consumers query by interface and optional filter. Service ranking and service ID provide ordering/selection semantics when multiple services match.

This supports late-bound provider selection, but it also means provider availability can change after a consumer has started. The consumer must have a defined response to replacement, disappearance, and property changes.

### 4.3 Service scopes

OSGi Core defines three service scopes:
- **Singleton:** the same registered service object is shared by consumers (default).
- **Bundle:** a ServiceFactory creates/customizes one service object per using bundle.
- **Prototype:** a PrototypeServiceFactory can provide distinct objects per request through ServiceObjects.

Factories allow a provider to associate state and resource cleanup with a particular consuming bundle or service-object use. They do not make the service object isolated or transactional.

### 4.4 Unregistration and stale references

Unregistration removes the service from the registry. An UNREGISTERING event is synchronously delivered while the service is still valid so listeners can release it. After unregistration completes, the ServiceReference can no longer be used to obtain the object.

The OSGi specification warns that bundles must clean up stale references themselves. A stale reference is a Java object belonging to a stopped bundle's class loader or an unregistered service object. Such references can prevent class loaders and instances from being garbage collected, increasing memory use and potentially preventing native library updates.

The specification recommends Service Tracker or Declarative Services to help manage these dynamic references. It also warns that the behavior of an already-unregistered service object is undefined: it may continue to work or throw.

**CGP implication:** a service handle should have explicit ownership, validity, and revocation semantics. A raw object reference that survives provider removal is not a safe lifecycle abstraction.

## 5. Declarative Services: automation with dynamic binding costs

Declarative Services (DS) addresses the complexity of manually publishing, finding, and binding services. Component descriptions declare provided services and references; the Service Component Runtime (SCR) creates, activates, binds, deactivates, and introspects component instances.

A component configuration is activated only when the component is enabled, its bundle is started, and its references satisfy the declared policy/cardinality. Component instances are created for activated configurations and discarded when configurations deactivate.

DS reference policies are particularly relevant:

- **Static:** when a bound service becomes unavailable, the component configuration is deactivated. If a replacement is available, the component can be reactivated with the replacement.
- **Dynamic:** SCR can change the bound service set without deactivating the component. The component must correctly handle bind/unbind changes, which can occur on any thread after activation.
- **Reluctant/greedy policy options:** determine whether newly available matching services cause rebinding, including whether a better candidate replaces an existing binding.
- **Unary/multiple cardinality:** determines whether the reference requires one service or can bind a set.

DS improves author ergonomics and can defer activation until a service is requested, reducing startup and memory costs. The specification explicitly identifies dynamic complexity as a source of application robustness problems.

**CGP comparison:** CGP's current Slot model is intentionally explicit and composition-scoped. A contribution list is resolved during composition and ordered by stable keys. OSGi's registry is a continuously changing shared environment. Borrowing a dynamic service registry would require CGP to define how service disappearance interacts with an in-flight dispatch, deterministic ordering, authority, save capture, and composition isolation.

## 6. Security and isolation boundary

OSGi includes a security layer with signed JAR support, permission concepts, and fine-grained checks for framework operations and services. The security model is optional and depends on framework/runtime configuration.

However, OSGi bundles execute within the framework's JVM. Bundle-specific class loaders control visibility and type identity; they are not separate operating-system processes. A bundle that can execute arbitrary Java code is not equivalent to a WebAssembly guest with restricted imports or a separate process with OS-level permissions.

Therefore:
- Do not equate bundle boundaries with CGP's WebAssembly isolation boundary.
- Do not assume manifest metadata or package imports alone restrict filesystem, network, reflection, native code, or other JVM capabilities.
- Treat signatures as provenance/integrity evidence, not proof that code is benign.
- If CGP ever embeds JVM-style plugins, define the actual security boundary independently of the module/package system.

## 7. CGP comparison

Relevant CGP decisions reviewed:
- ADR 0002 — Manifests, Slots, and Resolution
- ADR 0003 — Execution, Trust, and Lifecycle
- ADR 0004 — Ordered Dispatch
- ADR 0005 — Module-Owned Saves
- ADR 0008 — Composition Profiles
- ADR 0010 — Execution Boundary
- ADR 0012 — Cross-Backend Execution and Aggregate Budgets
- ADR 0016 — Simulation Integrity

| Concern | OSGi approach | CGP approach / distinction |
|---|---|---|
| Installed module identity | Framework-assigned bundle ID plus symbolic identity and revisions | Package/module IDs and exact profile versions |
| Selection | Runtime installation and resolution against framework state | Caller selects exact packages through a profile/catalog |
| Dependency model | Generic requirements/capabilities, filters, transitive constraints, package wiring | Explicit capability requirements and module-owned Slots |
| Ordering | Resolver wires a consistent graph; lifecycle/start levels manage activation | Deterministic topological order and stable contribution order |
| Service discovery | Shared dynamic registry, filters, service events, scope | Explicit composition-local Slot contributions and service calls |
| Dynamic provider change | Service rebinding and update/refresh | No implicit mid-composition provider substitution |
| Lifecycle | Persistent install/autostart, bundle start/stop/update/refresh/uninstall | Explicit composition lifecycle and caller-driven operations |
| State | Bundle/framework storage and application-defined migration | Module-owned versioned save slices; host owns capture/restore lane |
| Failure handling | Framework events, lifecycle cleanup, resolution reports; application handles stale refs | Explicit refusal/diagnostics, rollback boundaries, mutation lane |
| Isolation | JVM/class-loader boundaries with optional permission model | In-process trusted code versus isolated Wasm worker/backend |
| Runtime observability | Bundle/service/framework events and wiring introspection | Composition diagnostics, backend lifecycle, explicit result reports |

### What CGP can learn from OSGi

1. **Separate package wiring from runtime service discovery.** They answer different questions and need different contracts.
2. **Use structured requirement/capability diagnostics.** Resolution failures should identify the unsatisfied requirement, candidate providers, and conflicting constraints.
3. **Make provider lifecycle visible.** Service registration/unregistration events and stale-handle diagnostics are useful even if CGP keeps composition-scoped slots.
4. **Treat update as a graph operation.** Replacing a provider can affect dependents and in-flight work; a future CGP hot-reload feature needs explicit dependency closure and quiescence semantics.
5. **Use declarative metadata to reduce author boilerplate only where it does not hide authority.** DS demonstrates how much lifecycle code can be automated, but its dynamic binding model also shifts complexity into the runtime and component author.
6. **Keep stable logical identity separate from artifact revision and runtime instance identity.** OSGi's bundle ID, revision, and wiring are distinct concepts.

### What CGP should not copy without a deliberate requirement

- A global mutable service registry shared across unrelated compositions.
- Implicit dynamic package resolution during active deterministic execution.
- Runtime update/refresh semantics that can stop and restart a transitive dependency closure without a CGP-defined quiescence protocol.
- JVM class loaders as a substitute for a real isolation backend.
- Persistent autostart as a default simulation execution model.
- A general-purpose resolver in Foundation if current exact-version profile resolution remains sufficient.

## 8. Suggested CGP conformance and design tests

| Test | Question |
|---|---|
| Provider removed while consumer holds a service handle | Is the handle invalidated, leased, or allowed to finish? |
| Provider replaced during dispatch | Does the current dispatch finish against its original snapshot? |
| Dependency updated with active dependents | What is the exact affected dependency closure? |
| Old revision remains referenced | Can it be observed and retired without unsafe unload? |
| Resolution has two equally valid providers | Is selection explicit, stable, and diagnosable? |
| Capability requirements conflict transitively | Does the report identify the complete unsatisfied chain? |
| Optional requirement becomes available later | Is activation unchanged or is a controlled re-resolution required? |
| Bundle-like module stops while service is in use | Are outstanding leases drained before shutdown? |
| Dynamic rebinding occurs concurrently | Is mutation ordered relative to save capture and simulation steps? |
| Untrusted module attempts host API access | Does the backend enforce the boundary independently of metadata? |

## 9. Open questions for the next OSGi study slice

- How does OSGi handle version ranges, package exports/imports, uses constraints, fragments, and split packages in concrete resolver cases?
- What are the exact refresh dependency-closure and removal-pending behaviors in Equinox under update/uninstall sequences?
- How do DS activation policies, reference cardinality, greedy/reluctant policy, and service scope interact under concurrent service churn?
- Which OSGi concepts are actually useful for CGP's future package catalog, diagnostics, and tooling, without introducing a mutable global runtime?
- Would a small declarative authoring layer for CGP Slots reduce boilerplate while preserving explicit resolution and lifecycle?

## Conclusion

OSGi demonstrates the value and the cost of runtime-managed modularity. Its strongest ideas are the generic requirement-capability model, structured resolution diagnostics, explicit lifecycle states, service scopes, and declarative dependency management. Its operational complexity is equally instructive: providers disappear, references become stale, updates preserve old wiring until refresh, and dynamic rebinding can occur concurrently.

For CGP, the useful lesson is not “become OSGi.” It is to understand the boundaries OSGi had to build around a dynamic shared runtime—and preserve CGP's deliberate choices about composition ownership, deterministic ordering, isolated execution, and host-controlled mutation.
