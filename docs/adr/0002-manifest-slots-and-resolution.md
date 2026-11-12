# ADR 0002 — Manifests, slots, and resolution

**Status:** Accepted for the module-host prototype.

## Decision

A manifest is a JSON object with a closed set of fields. Unknown fields are errors. Versions are `major.minor.patch`. Ranges accept exact, `^`, `~`, and comparator sets such as `>=1.0.0 <2.0.0`.

The host API is `1.0.0`. A module loads only when that version satisfies its `moduleApi` range.

The Foundations expose one slot, `platform.systems`, a registry of opaque payloads. Domain slots are owned by modules. Flora and Lighting are not known to the host.

Slot kinds and their refusal rules:

| Kind | Rule |
|---|---|
| singleton, policy | One provider. More than one is a conflict. Nobody is activated. |
| service | One provider. More than one is ambiguous. Nobody is activated. |
| registry | Many providers. Order is `(order, module id, contribution id)`. Stored only. |
| pipeline | Many providers, same order. `runPipeline` folds a value and stops at the first failure. |
| subscriber | Many providers, same order. `publish` fans one event out. A throw does not stop the rest. |

Connections name a slot and a contract reference (`contract.id/1` or an exact version). The contract id and major must match the owner's declaration. A module cannot connect to a slot it owns.

Dependencies are capabilities, not package names, unless `moduleId` is set. Optional requirements warn and continue when nobody provides them. Two or more matching providers are ambiguous, optional or not, and the host does not pick one. A `moduleId` pin selects that provider. Cycles fail the composition. Nesting deeper than 8 fails the composition.

Invalid manifests are isolated. A valid neighbor can still activate. A conflict, cycle, bad contract, or thrown `initialize` refuses the admitted graph: nothing remains registered.

Resolution order is a topological sort. Ties break by module id, byte order, not by input order.

## Consequences

Two growth policies on `flora.growth-model` refuse the whole composition instead of blending. That is intentional.
