# ADR 0010 — Execution boundary

**Status:** Accepted. The in-process backend is not a sandbox.

## Decision

Foundations never call a module function directly. `register`, `initialize`, `shutdown`, `exportState`, `importState`, and slot payloads go through an `ExecutionBackend`.

A backend declares the grants it cannot revoke: `filesystem`, `network`, and `os`. It also declares whether it can enforce a time limit and a memory limit.

`compose` applies a policy. The default policy allows no grants and sets no limit. The in-process backend grants all three and cannot enforce limits, so the default policy refuses it before any hook runs. `trust: "trusted-in-process"` or `policy: IN_PROCESS_POLICY` is the explicit opt-in. A policy that sets `maxHookMs` or `maxMemoryBytes` refuses a backend that cannot enforce them. The host does not pretend the limit was applied.

A caller may pass a different `backend`. Module manifests, slots, and hooks stay the same.

The host passes a frozen context with `moduleId`, `contribute`, and `keep`, or `moduleId`, `ownedSlot`, and `kept`. It does not pass filesystem, network, or operating-system handles. `ownedSlot` returns copies of the contribution records so a module cannot rewrite the host's bookkeeping. The payload itself is the slot interface and is shared.

Module-to-module calls go through slot contracts and capability requirements. The host does not hand one module another module's implementation.

## Consequences

One module's thrown hook is contained by the backend and reported as a diagnostic. Registration and initialization still roll back, as before. A subscriber failure still does not stop the other subscribers.

The in-process backend cannot stop a module from importing filesystem or network APIs on its own, and it cannot stop an infinite loop. That is why those grants are listed and why a limit on that backend is a refusal, not a claim. An isolating backend can replace it without a new manifest or slot model. None is shipped here.
