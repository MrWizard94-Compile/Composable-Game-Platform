# ADR 0005 — Module-owned saves

**Status:** Accepted. This is not a world format and not a migration framework.

## Decision

A module may declare `save: { version }` with an exact semantic version. The host does not invent a save for a module that omits it.

`keep(state)` during register stores one value on that composition, not on the module singleton. `exportState` returns JSON. `importState` receives a slice and may mutate the kept value. The host JSON-clones the export and refuses values that do not survive `JSON.stringify`. Object keys are sorted on the way out and on the way in. Array order is kept. Key order is not part of the save.

`captureSave` walks the active order and records one slice per declaring module. `restoreSave` writes slices back.

Restore rules:

- The document's Foundations API major must match this host. Otherwise nothing is applied.
- A slice major must match the major the module declares now. `1.1.0` may load into a module that declares `1.0.0`. `2.0.0` is refused and that module's current state stays.
- A missing slice is a warning. The module keeps what it has.
- A slice for a module that is not active is a warning and is not read.
- Two slices for the same module are an error. Neither is applied. The host does not pick one.
- A different profile name or fingerprint is a warning. Slices are still matched by module id and save major.
- One module's `importState` failure stops the restore. The host puts back the snapshot it took before the call, including the module that threw, and later slices are not applied. The report's `applied` list is empty. `importState` may return a promise. The host waits for it.
- If the put-back of a thrown import itself throws, the notice is `save.rollback` and that module may keep the change. The host does not invent a second copy of the module's memory.
- `captureSave` uses the same lane as `restoreSave`. It waits until an in-flight restore or simulation step has finished, including completion subscribers. It does not record one module's new slice beside another's old slice.
- A `captureSave` or `restoreSave` started from inside that operation, including after the hook awaits, is refused with `save.reentrant`. It does not wait, and it does not deadlock. A callback that leaves the hook's promise chain is an outside caller and waits on the lane.

`shutdown()` marks the result quiesced. Capture, restore, `publish`, and `runPipeline` then refuse. The contribution list is still readable.

The console may hold the document in browser storage. That store is not part of the host.

## Consequences

Pulse Count can remember how many pulses it saw without the host knowing what a pulse count means. A future module that changes its save major must refuse old slices until it ships an `importState` that understands them. The host will not guess.
