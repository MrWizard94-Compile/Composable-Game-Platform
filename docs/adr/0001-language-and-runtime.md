# ADR 0001 — Language, runtime, and first target

**Status:** Accepted for the module-host prototype.

## Context

The first milestone has to discover modules, validate manifests, resolve a slot graph, and execute a nested composition. It does not need a renderer, a world, or a sandbox. The host must run in automated tests and in the browser console that demonstrates it.

## Decision

- TypeScript, executed directly by Node's type-stripping test runner and bundled by Vite for the console.
- The host API is pure data in, result out: `compose(packages)`.
- The first target is headless. The browser console is a viewer over that same function, not a second host.
- Modules in this milestone are trusted in-process objects plus a JSON manifest. There is no WASM, isolate, or permission enforcement.

## Alternatives

- A separate process or WASM sandbox per module. Rejected for the first milestone because the slot model is the risk, not native escape. ADR 0003 records that this build is not a sandbox.
- YAML manifests. Rejected to avoid a parser dependency. JSON is deterministic, schema-validated, and diffable.
- A game engine as the host. Rejected. The Foundations must not assume a world model.

## Consequences

Browser packages are bundled. Node tests discover the same folders from disk. Those two catalogs are asserted identical so they cannot drift.
