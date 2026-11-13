# ADR 0004 — Ordered dispatch

**Status:** Accepted. This is not a frame loop.

## Decision

`publish(result, slotId, event)` fans one value out to a subscriber slot. `runPipeline(result, slotId, input)` folds one value through a pipeline slot. Both walk contributions in the order the host already stored: `(order, module id, contribution id)`.

A callable contribution is a function, or an object with a `handle` function. The host does not interpret any other field. If the call returns a promise, the host waits for it. A rejection is a throw. A promise is not itself a pipeline value.

Subscriber failures are isolated. A throw, or a contribution that is not callable, is reported and the next listener still runs. The composition is not rolled back.

Pipeline failures stop the fold. A throw, a contribution that is not callable, or an `undefined` return keeps the last accepted value and does not call later stages. Skipping a stage would change the result without saying so.

Both calls refuse when the runtime is inactive, the slot is missing, the slot kind is wrong, or the slot is not `ok`. They do not register anything and they do not start a tick.

`shutdown()` does not clear the contribution list. Dispatch does not grow a second lifecycle flag. A caller that has shut the runtime down should stop asking it to run.

## Consequences

Signals Core can own `signals.listeners` and `signals.pipe` without a host change. A listener that throws does not hide a later listener. A pipeline stage that throws hides every stage after it. That difference is the slot kind, not a special case for the demo.
