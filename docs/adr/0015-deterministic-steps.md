# ADR 0015 — Caller-driven simulation steps

**Status:** Accepted. This is not a clock, and it is not a physics engine.

## Decision

Simulation Core owns a pipeline slot, a completion slot, and three services: seed, read, and commit. Simulation Ledger is the only provider of those services. It keeps integer positions and the last committed tick. A record is `{ id, x, y }`. The host does not read it.

`advanceSimulation` lives outside the Foundations. One call requests one step. The request carries the next tick, a positive integer delta, and an input snapshot. The runner reads the ledger, copies it, and passes that copy through `runPipeline` on `sim.systems`. A system returns a proposal. It does not write the ledger.

Contribution order is `(order, module id, contribution id)`. Package order is not the simulation order. Movement proposes one integer move per entity. The boundary guest clamps each move into the inclusive range 0 through 1000. A later system can still change a command. The runner commits only when the pipeline returns one in-range move for every entity, the tick and the snapshot are unchanged, and the ledger accepts that exact entity set at the next tick. The ledger checks those positions itself. A direct commit cannot skip the range, the entity set, or the next-tick rule, and it is refused unless that step is open. Otherwise the ledger stays as it was.

A failed pipeline stops later systems. The runner aborts the open mark, and a proposal that fails the check never changes the ledger. After a successful commit the runner publishes one completion event. It does not publish when the commit is refused. Subscriber failures stay isolated and do not roll the tick back. Concurrent calls and the rule for state a system writes itself are in [ADR 0016](0016-simulation-integrity.md).

There is no loop in the runner. There is no timer. An idle composition stays at its last tick until a caller asks again. The same ledger, the same delta, and the same inputs produce the same positions. Save and restore use the existing slice document. Integer positions are the proof. This milestone does not claim bit-identical floating-point results.

## Consequences

Two independent systems can share one step, including a JavaScript system and a WebAssembly guest, without the host learning what a move is. Physics, rendering, input devices, audio, networking, and a self-running frame loop remain out of scope. The boundary range is a contract of these modules, not a general spatial model.
