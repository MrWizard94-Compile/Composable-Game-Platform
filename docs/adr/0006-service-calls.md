# ADR 0006 — Service calls

**Status:** Accepted. This is still not a frame loop.

## Decision

`callService(result, slotId, input)` invokes the single provider of a service slot. The payload is a function, or an object with a `handle` function, same as subscriber and pipeline dispatch.

The return value is whatever that function returns, including `undefined`. A service is not a fold, so an empty return is not a failure.

A throw is reported on that one call. Nothing else runs, because there is only one provider.

Zero providers is a refusal: "no provider." Two or more providers are already an ambiguous slot, the composition does not activate, and `callService` refuses with the inactive-runtime reason. The host does not pick.

The same gates as `publish` and `runPipeline` apply: inactive runtime, quiesced runtime, missing slot, wrong kind, or a slot that is not `ok`.

A service slot may declare `mutates: false`. The host then does not place that call on the composition's operation lane. Omitted, the service may change exported state, and `callService` uses that lane except in two cases. The caller is already on the lane, including the simulation runner and a save hook. Or a step currently holds the lane: the call runs immediately, a service it awaits is part of that same call, and the next lane operation waits for it. `sim.read` declares `mutates: false`. What a successful capture includes is [ADR 0005](0005-module-owned-saves.md).

## Consequences

Query Core can own `queries.ask` without a host change. Name Index is the provider. Alias Index beside it makes the slot ambiguous and neither implementation is called.
