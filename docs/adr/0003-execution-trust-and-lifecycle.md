# ADR 0003 — Execution, trust, and lifecycle

**Status:** Accepted for the module-host prototype. Limits are deliberate.

## Lifecycle

`discover → validate → resolve → prepare → register → initialize → run`, then `shutdown` on request.

`register` collects contributions. A module may `keep` one composition-local value there. `initialize` runs only after every registration succeeded, in topological order. `run` means the result is readable. There is no tick loop inside the host. Demo runners live outside the Foundations. Subscriber, pipeline, and service slots execute only when a caller uses `publish`, `runPipeline`, or `callService` (ADR 0004, ADR 0006). Save slices are captured and restored by the caller (ADR 0005). `shutdown()` quiesces the result; later dispatch and save calls refuse.

If `initialize` throws, modules whose `register` completed are shut down in reverse registration order, except the module that threw. Contributions are discarded. `shutdown()` on a live result runs once, in reverse initialization order.

## Trust

Modules are trusted in-process code. A permission list does not create a boundary. This host is not sandboxed, not a multiplayer authority, and not hot-reloadable. Determinism is tested for module order, contribution order, and pure demo payloads. Rendering, input, and clocks are outside that claim.

## What stays out of the host

Plant records, growth math, and light sources live in module packages. A test reads the Foundations sources and fails if those words appear. A module written only in a test file can connect to a slot exposed by Flora Core without editing the host or Flora Core.
