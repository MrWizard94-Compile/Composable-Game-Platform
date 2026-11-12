# ADR 0003 — Execution, trust, and lifecycle

**Status:** Accepted for the module-host prototype. Limits are deliberate.

## Lifecycle

`discover → validate → resolve → prepare → register → initialize → run`, then `shutdown` on request.

`register` collects contributions. A module may `keep` one composition-local value there. `initialize` runs only after every registration succeeded, in topological order. `run` means the result is readable. There is no tick loop inside the host. Demo runners live outside the Foundations. Subscriber, pipeline, and service slots execute only when a caller uses `publish`, `runPipeline`, or `callService` (ADR 0004, ADR 0006). Save slices are captured and restored by the caller (ADR 0005). `shutdown()` quiesces the result; later dispatch and save calls refuse.

If `register` fails, every module whose `register` was entered is shut down, including the one that failed, in reverse entry order. A module that had not started `register` is left alone.

If `initialize` throws, every module whose `initialize` was entered is shut down, including the one that threw, in reverse entry order. A module that had not started `initialize` is not shut down. Contributions are discarded.

`shutdown()` on a live result runs once, in reverse initialization order. A throw from one module does not skip the rest.

## Trust

The host does not run module code except through an execution backend (ADR 0010). The default policy allows no filesystem, network, or operating-system grant. The in-process backend has those grants and cannot enforce time or memory limits, so it does not run unless the caller opts in.

That opt-in is not a sandbox. A permission list in a manifest is still not a boundary. Hot reload, replication, and resource enforcement belong to a backend that can actually do them. This host refuses a backend that cannot, instead of ignoring the request.

## What stays out of the host

Plant records, growth math, and light sources live in module packages. A test reads the Foundations sources and fails if those words appear. A module written only in a test file can connect to a slot exposed by Flora Core without editing the host or Flora Core.
