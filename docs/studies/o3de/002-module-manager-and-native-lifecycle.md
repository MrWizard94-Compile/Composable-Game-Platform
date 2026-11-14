# O3DE Study 002 — ModuleManager and Native Module Lifecycle

**Research date:** 2026-11-14  
**External project:** Open 3D Engine (O3DE)  
**O3DE source revision inspected:** 32d6eddc51f9e87e967e811fb16a07d009b2d42c (development)  
**CGP comparison baseline:** 37739db60e77e69369e002bfa5d54ce4159c2438

## Purpose

Inspect O3DE's actual ModuleManager implementation rather than relying only on Gem documentation. Focus on native library loading, module instance creation, lifecycle stages, ownership, activation ordering, failure behavior, and unloading.

## Executive finding

O3DE's ModuleManager is a native dynamic-library lifecycle manager integrated with O3DE's component/entity system. It is not, by itself, a general-purpose module dependency composer.

The package dependency resolver, operating-system library loader, and runtime System Component dependency sorter operate at different layers. CGP combines manifest-driven module and Slot relationships into a composition graph, so these systems should not be treated as equivalent.

## 1. The runtime object is separate from the Gem

For a Code Gem, the compiled library is loaded as a native module. O3DE expects the library to expose C-linkage entry points. The normal module macro generates the module-class creation and destruction entry points; the dynamic-library handle deals with module-level initialize/uninitialize entry points.

The relevant types are:

- **DynamicModuleHandle:** platform-specific wrapper for loading, resolving functions from, and unloading a shared library.
- **AZ::Module:** C++ object representing the loaded module. It registers component descriptors and can declare required System Components.
- **ModuleDataImpl:** lifetime record containing the dynamic handle (when applicable), module object, optional ModuleEntity, and last completed initialization step.
- **ModuleManager:** coordinates loading, ownership, registration, activation, deactivation, and unloading.

A static/monolithic build has a separate path: modules are created by a callback and stored without a DynamicModuleHandle. O3DE's documentation describes monolithic builds as linking modules into the executable rather than loading dynamic libraries.

## 2. Explicit initialization stages

The ModuleManagerBus header defines these ordered stages. They are an enum describing progress, not bit flags:

| Stage | What happens |
|---|---|
| None | No module initialization completed |
| Load | Create a DynamicModuleHandle and load the native library |
| CreateClass | Call the library's CreateModuleClass entry point and obtain an AZ::Module |
| RegisterComponentDescriptors | Register the module's component descriptors with the application |
| ActivateEntity | Create/associate the module's ModuleEntity and activate its selected System Components when the System Entity is ready |

LoadDynamicModule accepts a lastStepToPerform argument. ModuleDataImpl stores m_lastCompletedStep. A later request for a later stage can continue from the existing stage; a request for a stage already completed returns the existing shared ModuleData.

This is an incremental module-startup mechanism. It allows the caller to stop at a defined phase rather than forcing every load request to run all the way through component activation.

### Dynamic-library entry points

The source defines four important entry points:

1. InitializeDynamicModule — called by DynamicModuleHandle after the OS library load. In the inspected implementation this is a parameterless function; the handle coordinates initialization using an AZ::Environment variable keyed from the module filename.
2. CreateModuleClass — creates and returns the AZ::Module instance.
3. DestroyModuleClass — destroys that instance while the library is still loaded.
4. UninitializeDynamicModule — called before unloading the library by the handle that owns the initialization token.

The order matters. The object is created and destroyed by code inside the same native library. The module object is destroyed before the library is unloaded; module-level uninitialization runs before the OS library unload.

The environment token is used so multiple handles to a library in the same AZ::Environment do not independently run initialization and uninitialization. The handle that creates/owns the token is the one that invokes the uninitialize entry point when it releases that token.

## 3. Identity and ownership

The ModuleManager normalizes module paths through the ComponentApplication's ResolveModulePath callback. It uses the resulting path as the key in a map from module path to weak ModuleData references.

LoadDynamicModule returns a shared ModuleData reference:

- Repeated loads of the same resolved path can share the same ModuleData and AZ::Module instance.
- The manager stores its own strong reference in m_ownedModules when maintainReference is true.
- When maintainReference is false, the caller's returned shared reference can determine how long the ModuleData remains alive.
- The weak map allows the manager to find a live instance without itself necessarily owning it.

During UnloadModules, O3DE deactivates the System Components and drops manager-owned module references in reverse order. The ModuleDataImpl destructor releases its ModuleEntity, calls DestroyModuleClass for a dynamic module (or deletes a static module directly), and then unloads the dynamic library handle.

The manager includes a tracing diagnostic if it is destroyed while non-owned module references are still open. This is an important lifetime contract: external ModuleData references must not be casually allowed to outlive the manager/application environment that created them.

## 4. Component activation is a separate dependency layer

The native ModuleManager does not perform Gem package version resolution. O3DE's Gem dependency resolver runs when configuring the project with CMake.

At runtime, ModuleManager processes the supplied dynamic module descriptors in their input order. The separate ActivateEntities routine then:

1. Gets each module's required System Component types.
2. Includes component descriptors selected by the configured System Component tags.
3. Creates or associates a ModuleEntity for the module.
4. Includes the application System Entity and already-active system components in the dependency set.
5. Topologically sorts the components using Entity::DependencySort.
6. Activates the components in the resulting order.

This gives O3DE at least three distinct dependency layers:

| Layer | Responsibility | When it operates |
|---|---|---|
| Gem dependencies | Select compatible packages and required Gem versions | Project configuration/build |
| Native library dependencies | Resolve shared-library dependencies and load the binary | Native library loading |
| System Component dependencies | Order component activation based on component service dependencies | Runtime activation |

These layers solve different problems. In particular, the runtime component sort is not the same as CGP's manifest-level module/Slot composition graph.

The source also includes duplicate-descriptor handling: a newly loaded module removes component descriptors already owned by another loaded module, avoiding multiple modules releasing the same descriptor.

## 5. Failure behavior and important caveats

Observed failure handling includes:

- Failure to create a DynamicModuleHandle or load the library returns a failed Outcome.
- A missing required CreateModuleClass entry point or a null module-class result returns a failed Outcome.
- The failed module is removed from the manager's owned list and path map; references are released.
- Component descriptor registration is a void operation in this path, not a result-bearing validation phase.
- A component dependency-sort failure is logged and may be shown through NativeUI with a Quit or Ignore choice.

One notable behavior: ActivateEntities returns void. If its component dependency sort fails, the outer ActivateEntity loading phase still returns success after the activation routine returns. The error is handled through O3DE's logging/interactive policy rather than propagated as a structured LoadDynamicModule failure. This is an observed implementation behavior, not a claim that O3DE has no other application-level error handling.

For CGP, the useful caution is to keep runtime lifecycle failures machine-readable and explicit, especially for headless execution. An interactive dialog is not an appropriate default failure mechanism for a reusable module host.

## 6. Platform-specific loading details

DynamicModuleHandle abstracts the operating-system library operations, while ModuleManagerSearchPathTool is platform-specific. The inspected Windows implementation sets the DLL search directory to the directory of the module being loaded and resets it when the helper is destroyed. The inspected Linux implementation of SetModuleSearchPath is empty.

Therefore, dependent native-library lookup is not one uniform cross-platform algorithm implemented solely by ModuleManager. The underlying platform loader and the platform-specific helper matter.

This is another reason not to equate an O3DE native module with a CGP WebAssembly guest.

## 7. Comparison with CGP

At the CGP comparison baseline, the host already has a different lifecycle and trust model:

| Concern | O3DE ModuleManager | CGP Foundation |
|---|---|---|
| Runtime implementation | Native C++ shared library or static module | Trusted in-process JavaScript or isolated WebAssembly backend |
| Unit of composition | Module object and its System Components | Manifest-described module and its Slots/contributions |
| Dependency ordering | Gem resolution at project configuration; component dependency sort at activation | Manifest capability/Slot dependencies resolved into a composition graph |
| Lifecycle | Native library load, module class creation, descriptor registration, System Component activation | Discover, validate, resolve, prepare, register, initialize, caller-driven runtime |
| Ownership | Shared ModuleData references plus optional manager-held references | Composition-owned runtime/backend session |
| Shutdown | Deactivate components, destroy module object, uninitialize and unload native library | Reverse initialized-module order, then release the execution session |
| Isolation | Native modules share the host process | WebAssembly guest isolation is an explicit backend option; in-process JavaScript is trusted |

CGP's host currently initializes modules in topological order and shuts them down in reverse initialized order. If initialization fails, it shuts down the modules that entered initialization and releases the backend session. That behavior is implemented in the current host rather than inferred from O3DE.

## 8. Lessons for CGP

### Worth preserving or studying

1. **Explicit lifecycle stages.** O3DE records the last completed loading stage. CGP already records composition phases; staged per-module loading should only be added if a real need such as incremental activation or hot reload emerges.
2. **Clear ownership semantics.** Document exactly who owns a module instance, backend session, worker, or artifact handle, and what must be released before the host shuts down.
3. **Destroy with the implementation that created.** O3DE's exported destroy function ensures the module object is destroyed while its native library remains loaded. This is particularly relevant if CGP ever adds native extension support; it is not a reason to introduce native modules now.
4. **Reverse-order teardown.** A dependent should normally stop before the capability it depends on. CGP's reverse topological shutdown is consistent with this principle.
5. **Keep dependency layers distinct.** Package resolution, runtime composition, and operating-system dependency loading should not be conflated.
6. **Prefer structured errors.** CGP should keep its diagnostics and phase outcomes inspectable and should avoid requiring interactive UI to make headless lifecycle decisions.

### Deliberately do not copy

- Do not replace WebAssembly isolation with native dynamic libraries. A shared-library boundary is not a sandbox.
- Do not introduce O3DE's component/entity model into the domain-agnostic Foundation.
- Do not add a global service bus merely because O3DE uses EBus. CGP's explicit Slot graph is a deliberate architectural difference.
- Do not add partial module-loading states until an actual use case justifies their additional lifecycle complexity.
- Do not adopt CMake or O3DE's Gem model as CGP's package/distribution format.

## 9. Conclusions

O3DE's ModuleManager is a useful reference for native plugin lifecycle, explicit stage progression, reference ownership, and safe destruction ordering. Its most useful ideas for CGP are about **lifecycle discipline and ownership**, not about copying its native runtime architecture.

The key architectural distinction is now clearer: O3DE's Gem system packages and resolves engine extensions, while ModuleManager loads native code and activates components. CGP's central abstraction is different: a backend-aware composition of modules connected through explicit Slots and contracts.

No CGP implementation change is proposed by this study.

## Sources

### O3DE source at inspected revision

- [ModuleManager.cpp](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/ModuleManager.cpp)
- [ModuleManager.h](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/ModuleManager.h)
- [ModuleManagerBus.h](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/ModuleManagerBus.h)
- [Module.h](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/Module.h)
- [DynamicModuleHandle.cpp](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/DynamicModuleHandle.cpp)
- [DynamicModuleHandle.h](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/AzCore/Module/DynamicModuleHandle.h)
- [Windows ModuleManagerSearchPathTool](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/Platform/Windows/AzCore/Module/Internal/ModuleManagerSearchPathTool_Windows.cpp)
- [Linux ModuleManagerSearchPathTool](https://github.com/o3de/o3de/blob/32d6eddc51f9e87e967e811fb16a07d009b2d42c/Code/Framework/AzCore/Platform/Linux/AzCore/Module/Internal/ModuleManagerSearchPathTool_Linux.cpp)

### CGP source at comparison baseline

- [CGP host lifecycle and composition](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/37739db60e77e69369e002bfa5d54ce4159c2438/src/foundations/host.ts)
