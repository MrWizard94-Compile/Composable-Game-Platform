# ADR 0016 — Simulation integrity

**Status:** Accepted. This is not a transaction manager for arbitrary module memory.

## Decision

The Simulation Ledger is the authority for positions and the tick. The runner is not. Every commit, including `callService` on `sim.commit`, has to be an open step, the next integer tick, the same entity ids in the same order, and integer coordinates in the inclusive range 0 through 1000. Seed and save use that same range. A check that fails does not change the tick or the positions. Abort clears the open mark and does not roll a commit back. Shutdown clears the open mark and does not commit.

`advanceSimulation` and `seedSimulation` for one composition run one at a time, in the order the calls were made. The runner opens the step before the pipeline and aborts that mark if it does not commit. Two calls for the same tick produce one commit. Two calls for the next ticks, made in tick order, both commit, with no skipped or duplicated tick. A later tick submitted before the next one is refused, and the tick does not jump. A direct seed while a step is open is refused and adds nothing. A seed made through the runner waits, then follows the closed-seed rule if the step committed. A direct commit that passes the ledger rules can take the open step. The runner then does not commit again and does not publish. Completion is published only after the runner's own commit succeeds. A refused step publishes nothing.

A system on `sim.systems` receives a snapshot and returns a proposal. It must not write the ledger, and it must not keep its own state during that call. The host does not roll back a scratch variable a system changes before a later system fails. The supported place to record a committed step is `sim.completed`, which runs only after the ledger accepts the step. A completion subscriber must not call `advanceSimulation` or `seedSimulation` on that composition. That call would wait for the step that is waiting for the subscriber.

Save and restore still use the slice document. The open mark is not saved. Restoring a slice while a step is open is refused. The same inputs, including after save and restore, produce the same ledger on the Node isolate and in a browser isolate. The proof composition is mixed: movement is JavaScript, and the boundary is WebAssembly.

## Consequences

There is still no prepare, commit, and abort protocol for module-local memory. A system that needs memory across steps listens for completion, or it waits for a later milestone. Physics, rendering, and a self-running clock stay out of scope. The 0 through 1000 range remains a contract of these modules, not a general spatial model.
