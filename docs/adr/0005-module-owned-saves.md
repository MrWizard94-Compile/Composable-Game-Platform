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
- `captureSave` uses the same lane as `restoreSave`, a simulation step, and a mutating service. It waits until that earlier operation has finished, including completion subscribers and a mutating service that was admitted while a step still held the lane. It does not record one module's new slice beside another's old slice.
- The host tracks the composition whose hook is running, including after that hook awaits. On Node this is `AsyncLocalStorage`, and `Promise.prototype` is left alone. Chromium has no async-context API, and native `await` does not call `Promise.prototype.then`, so the browser bundle lowers `await` and the page binds those reactions to that composition's frame. The lane, the save hook, and a step-time direct mutation share that one frame. A `captureSave` or `restoreSave` for that same composition, from `importState`, `exportState`, a system, or a completion subscriber, is refused with `save.reentrant`. It does not wait, and it does not deadlock. A save for a different composition is not that hook's call: it uses the other composition's lane. A callback that leaves the hook's promise chain is an outside caller.
- A service slot may set `mutates: false`. Omitted, the service may change exported state. The field is refused on any other kind, and on a value that is not a boolean. The host does not inspect the provider to prove the declaration.
- A mutating service uses that same lane, in call order, unless the caller is already on it. A mutating service requested while a capture is walking waits until the capture finishes. It does not change a slice in that document. One composition's service does not delay another composition's capture.
- The simulation runner calls services while it holds the lane, so those calls run immediately. A capture that was waiting on the step sees them in every slice. An outside mutating service that arrives while a step holds the lane also runs immediately, which is what lets a direct commit see the open step. A mutating service that this call awaits is part of the same call. The next lane operation, including a capture, does not start until the call settles.
- A service declared `mutates: false` does not take the lane. `sim.read` is one. It stays a live observation during an open step and during a capture. If that provider calls a mutating service, the inner call still uses the lane.
- A service called from `exportState` or `importState` is already inside the lane, so it runs immediately. It can change a module the walk has not reached. A slice already returned stays as that hook returned it. A successful capture is the lane cut above. It is not one instant against the capture's own hooks.

`shutdown()` marks the result quiesced. Capture, restore, `publish`, and `runPipeline` then refuse. The contribution list is still readable.

The console may hold the document in browser storage. That store is not part of the host.

## Consequences

Pulse Count can remember how many pulses it saw without the host knowing what a pulse count means. A future module that changes its save major must refuse old slices until it ships an `importState` that understands them. The host will not guess.
