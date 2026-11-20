# Study 014 — Deterministic simulation, state authority, and replay boundaries

Date: 2026-11-20. Repository baseline: `f85ccbbea2b7a2872dce2b1abf17781438f75560`.

This is research. It is not an ADR, not a change to `cgp.abi/1`, and not permission to implement a scheduler, a replay log, an RNG service, a transaction manager, or a networking stack. [ADR 0015](../../adr/0015-deterministic-steps.md) and [ADR 0016](../../adr/0016-simulation-integrity.md) stay the accepted contracts. [Study 013](013-wit-compatibility-prototype.md) stays the WIT prototype record. This study does not revise it.

## 1. Executive findings

1. CGP's deterministic proof is narrow and caller-driven. One `advanceSimulation` call requests one integer tick. The runner does not loop, and it does not read a clock. The inspected runner source is what the test scans for timers.
2. The Simulation Ledger is the authority for this proof's tick and positions. The runner is not a privileged principal. A direct `sim.commit` can finish an open step, skip the proposal, and publish nothing. That is accepted behavior, not a leak discovered here.
3. A failed proposal does not change the ledger. It also does not roll back module-local scratch. ADR 0016 already says this. The scratch test demonstrates it. The pipeline is not a transaction manager.
4. The same caller requests, on this composition, produce the same integer ledger on the Node isolate and in Chromium, including after save and restore. That is same-process and same-proof cross-runtime evidence for these integers. It is not a cross-OS result, not a float result, and not a network result.
5. A save restores module slices. It does not store the drives that produced the tick. The open mark is omitted. A fingerprint mismatch warns and does not refuse the restore. Ledger and witness slices are not checked against each other.
6. Nothing in `src/` calls `Math.random`. The proof has no RNG stream to restore. A global seed is not a missing feature of this ledger. It would also not be sufficient later if call order can change.
7. External engines do not offer one meaning of "deterministic." Doom records inputs and re-simulates. Quake 1 records server messages. Bevy separates a variable frame from zero or more fixed steps and still does not promise one parallel order. Source and GGPO correct a prediction against authority. WebAssembly's own spec leaves NaN payloads non-deterministic. CGP should not copy any of those mechanisms into Foundations.
8. Before a reference game, the useful missing piece is a persisted input record outside Foundations, plus a check that a second composition with the same fingerprint re-executes the integer ledger. Rollback netcode, a Foundations clock, and a float mandate should wait.

## 2. Questions and scope

The question is what deterministic behavior the current simulation actually guarantees, which stronger guarantees are separate engineering problems, and which of those are worth building before a reference game.

In scope: authoritative state for the existing integer proof, contribution order, caller ticks, inputs, save and restore, the mutation lane, module-private scratch, completion, and the boundary between this proof and asynchronous work. Also the external models named below, only as far as they change that recommendation.

Out of scope: implementing any of it; a new ADR; physics; rendering; audio; a networking protocol; a developer console; a generic ECS; a self-advancing scheduler; a mandate that all future math be bit-identical floating point; changes to Study 013 or `cgp.abi/1`.

Games are the first application of CGP, not a reason for Foundations to learn entities, vectors, or clocks. World Core and Step Clock in [ADR 0009](../../adr/0009-records-and-steps.md) are a different pair of modules. They count records and caller steps. They are not this ledger.

## 3. Baseline and files inspected

HEAD at the start of this study was `f85ccbbea2b7a2872dce2b1abf17781438f75560` on `main`. No production file changed for this study.

CGP files read against that commit:

- [ADR 0009](../../adr/0009-records-and-steps.md), [ADR 0015](../../adr/0015-deterministic-steps.md), [ADR 0016](../../adr/0016-simulation-integrity.md)
- [docs/STATUS.md](../../STATUS.md), the simulation and save bullets only
- [src/modules/sim.ts](../../../src/modules/sim.ts) and [src/modules/sim.test.ts](../../../src/modules/sim.test.ts)
- `org.cgp.sim-core`, `org.cgp.sim-ledger`, `org.cgp.sim-move`, `org.cgp.sim-bound` (`guest.ts` and manifest), `org.cgp.sim-witness`
- [src/modules/registry.ts](../../../src/modules/registry.ts) `SIM_IDS`
- [src/foundations/host.ts](../../../src/foundations/host.ts) `contributionSort`, `fingerprintOf`, `runExclusive`
- [src/foundations/dispatch.ts](../../../src/foundations/dispatch.ts) `runPipeline`, `publish`, `callService`
- [src/foundations/save.ts](../../../src/foundations/save.ts) document shape and fingerprint warning
- [src/foundations/cross-backend.ts](../../../src/foundations/cross-backend.ts) `CROSS_POLICY`
- [src/foundations/wasm-isolate.ts](../../../src/foundations/wasm-isolate.ts) hook budget
- [scripts/browser-compose-entry.ts](../../../scripts/browser-compose-entry.ts) `runBrowserSimulation`
- [Bevy study 003](../bevy/003-ecs-data-ownership-scheduling-and-state-boundaries.md), as prior research, not as a substitute for the fixed-timestep files re-read here
- [Study 013](013-wit-compatibility-prototype.md) sections 6 and 7, for the prototype lane only

Searches under `src/`: no `Math.random`. `Date.now`, `setTimeout`, and `performance.now` appear in host budgets, store coordination, tests, and unrelated sandbox files. They do not appear in `sim.ts`, the ledger, movement, the witness, or the boundary guest.

## 4. Current implementation and tested guarantees

### 4.1 What a step is

`advanceSimulation` enqueues `advanceBody` on the composition lane (`runExclusive` in `host.ts`). One call is one requested tick. The test `does not schedule itself` reads `sim.ts` and asserts it does not contain `setTimeout`, `setInterval`, `setImmediate`, `requestAnimationFrame`, `queueMicrotask`, `performance.now`, or `Date.now`.

The request must name the integer `state.tick + 1`, a delta from 1 through 10000, and at most 32 drives. Each drive names an existing entity once, with an id matching `/^[a-z][a-z0-9]{0,15}$/` and a signed 32-bit `vx` and `vy`. A skipped tick returns `Tick must be the next integer.` A zero delta returns `Delta must be a positive integer.` The ledger is not changed. Idle reads return the same state. That is the test `stays put until a caller asks`.

The runner copies inputs and entities with `JSON.parse(JSON.stringify(...))` and opens the step with `sim.commit` `{ phase: "open", tick }`. It then runs `sim.systems`. After the fold it refuses the step unless `tick`, `delta`, `inputs`, and `entities` are unchanged and `commands` is one in-range `move` per entity, in entity order, with coordinates in 0 through 1000. Only then does it commit `{ tick, entities }` and publish `sim.completed`.

If the pipeline throws, a stage returns `undefined`, or the proposal fails that check, `committed` stays false. The `finally` block sends `{ phase: "abort" }`. Abort sets `open` to 0 and does not change `tick` or `entities`. The tests `does not commit a step whose pipeline fails` and `whose commands are out of range` cover a throw at order 15 and a command with `x: -4` after the boundary guest. Both leave the previous ledger in place. The second failure happens after every stage returned ok. The runner, not the guest, rejects the illegal command.

### 4.2 Who may read, propose, and commit

| Action | Who | When it becomes visible | Tested limit |
|---|---|---|---|
| Read | `sim.read`, declared `mutates: false` | A copy of `tick` and `entities`. `open` is not in the copy. The call does not take the lane | A read during a stalled pipeline still sees the last commit. A read after commit and before a slow subscriber sees the new tick while `heard` is still empty |
| Propose | Contributors on `sim.systems`, in sorted order | Nowhere, until a later commit | Movement appends moves. The boundary guest rewrites them. Neither module writes the ledger |
| Commit | The ledger's `sim.commit` provider | Immediately in the ledger object, before `publish` | The runner commits only after the proposal check. Any other caller may commit too |
| Record | `sim.completed` subscribers | After the runner's own commit returns ok | A direct commit does not publish. The witness `heard` stays empty |
| Abort | `{ phase: "abort" }`, or ledger `shutdown` | Clears `open` only | Shutdown does not commit |

The ledger's `commitEntities` refuses a closed step, a tick that is not `state.tick + 1`, a tick that is not the open mark, a different entity id sequence, a non-integer, or a coordinate outside 0 through 1000. Seed uses the same range, only while `open === 0` and `tick === 0`, at most 32 entities, and stores them sorted by id. A direct commit of the same positions is tested: the tick becomes 1, the witness slice is `{ heard: [] }`, and a second open of tick 1 is refused.

While the runner holds the lane, an outside `sim.commit` runs immediately (`callService` in `dispatch.ts`). The test `lets a direct commit take the open step` commits the pre-move positions during the stalled pipeline. The runner then gets `not an open step`, does not publish, and the save shows the stolen positions with an empty `heard`. ADR 0016 states this on purpose. In-process JavaScript is not a sandbox, and the host has no caller identity.

### 4.3 Ordering

`records.sort(contributionSort)` runs once at registration. The compare is `order`, then `moduleId`, then contribution id. Missing order is 0. Movement declares order 10. The boundary guest registers `bound` at order 20. The successful step's stages are `["move", "bound"]`. Reversing the package array does not change `fingerprint` and does not change the ledger after 100 steps (`replays 100 steps from a save and ignores package order`).

`runPipeline` feeds each stage's return value into the next. The first throw, missing function, or `undefined` stops the fold. Later systems do not run. `publish` does the opposite: one subscriber throwing is recorded, and the rest still run. The subscriber-failure test names `org.example.sim-break` and still records the tick on the witness and on a second subscriber.

Two `advanceSimulation` calls share one lane, in the order the calls were made. Two requests for the same next tick produce one commit. A later tick submitted before the next one is refused and the tick does not jump. Requests for ticks 3 and 4, made together after tick 2, both commit, and `heard` is `[1, 2, 3, 4]`.

`seedSimulation`, `restoreSave`, `captureSave`, and a mutating `callService` use that same lane. `sim.read` does not. A capture started during an open step does not finish until the step's subscribers finish. A capture started while a direct mutation from that step is still running waits for that mutation too. A restore and a runner step do not overlap: the test holds one, and the other does not finish. A restore while a directly opened step is still open is refused by the ledger. The host puts written slices back, so a hostile witness payload `{ heard: [99] }` does not stick.

A completion subscriber, and `importState`, must not call `advanceSimulation`, `seedSimulation`, or `restoreSave` on that composition. A nested `captureSave` from a subscriber is `save.reentrant`. The outer capture, after the subscriber finishes, sees both the new ledger and the subscriber's own slice. That is tested for a promise subscriber and for an async subscriber.

### 4.4 What "same positions" means in the tests

The helper `at(steps)` is the expected ledger for drives `e1 (1, 2)` and `e2 (-1, 0)` from `{e1: (0,0), e2: (10,0)}` with delta 1, after the boundary clamp:

- `e1` is `(min(1000, steps), min(1000, steps * 2))`
- `e2` is `(max(0, 10 - steps), 0)`

One hundred steps on one composition match fifty steps, a save, a restore, and fifty more. A third composition with the packages reversed matches the same ledger and the same `heard` list of ticks 1 through 100. The save slices are `{ tick, entities }` and `{ heard }`. They do not contain `open`, drives, or deltas.

The browser proof (`runBrowserSimulation`) runs the same packages on the browser worker: movement is a function, the boundary contribution is an ABI handle, 40 steps, save, restore onto a new composition, 40 more. `sim.test.ts` asserts both ledgers are `at(80)` and both witness lists are ticks 1 through 80. That assertion runs in the Ubuntu `foundations` job, which installs Chromium. It is not a Firefox run. The Windows and macOS jobs do not run `sim.test.ts`. They run activation tests, and those tests still refuse JavaScript project activation on those platforms. This study does not treat an unrun job as a pass.

`CROSS_POLICY` sets `maxHookMs: 1000`. The cross-backend comment says the isolate enforces that budget and the JavaScript half does not. The boundary guest can therefore fail closed because `Date.now` in `wasm-isolate.ts` decided the hook was too slow. The movement formula does not read that clock. A timeout stops the isolate (`Time limit exceeded. The isolate was stopped.`). That is a difference in whether a step completes, not a second integer result. The simulation tests do not assert this timeout.

## 5. State domains

| Domain | What occupies it today | Must a future authoritative snapshot include it? |
|---|---|---|
| Authoritative simulation state | Ledger `tick` and sorted `{id,x,y}` in 0..1000 | Yes, for this proof. The open mark must stay out. It is in-progress, and `exportState` already omits it |
| Deterministic derived state | None. Commands exist only inside the step | No, if they are a pure function of the snapshot and the inputs |
| Presentation-only state | None in this proof. No renderer | No |
| Local input prediction | None | No. Prediction is not authority |
| Replay or debug state | Witness `heard`: ticks observed on `sim.completed` | Only if the consumer needs the completion trace. It is not required to recompute positions. It can disagree with the ledger after a direct commit |
| Module-private persistent state | `ctx.keep` in the ledger and the witness, exported only if the module implements `exportState` | Whatever that module needs in order to repeat its own decisions. The host cannot discover the rest |
| Ephemeral scratch | A local mutated during `sim.systems` before a later stage throws | No. The host will not restore it, and a snapshot taken after the abort still shows the old ledger. The scratch test leaves `n === 1` and `heard` empty |
| Caller inputs | `tick`, `delta`, `inputs` on the request | Not inside the ledger slice. A replay log would have to store them beside it. Today they are discarded |
| Composition identity | `fingerprint` and `profileName` on the save document | A replay header should name them. Restore only warns when they differ |

`sim.seed` is entity insertion at tick 0. It is not a random seed. The name is a trap.

World Store records from ADR 0009 are a different table. This study did not find them on the simulation commit path.

## 6. Determinism levels

These are separate. A pass at one level is not evidence for the next.

| Level | Claim | CGP today |
|---|---|---|
| A. Same-process repeatability | Same build, same runtime, same initial state, same requests, same result | Demonstrated for this integer composition. One hundred repeated requests match `at`. A second composition with reversed packages matches. Not demonstrated for a module that keeps scratch, reads the clock, or commits directly |
| B. Same-runtime replay | A recorded input sequence reproduces the state on a compatible build | Partial. The tests re-issue the requests in memory. Nothing persists those requests. Save and restore reproduce the slices, which is a snapshot, not a replay. A direct commit is a state the input sequence would not have produced, and nothing records that fact |
| C. Cross-runtime repeatability | Node, Chromium, and other Wasm paths agree | Partial, and only for this proof. Node's isolate and Chromium's worker agree on the integer ledger after save and restore. The boundary path is core Wasm through the production ABI, not a Wasmtime component. Firefox was not in this test. Study 013's Firefox result is a different prototype |
| D. Cross-platform repeatability | Other operating systems and architectures agree | Not demonstrated. There is no recorded simulation run on Windows, macOS, or a second CPU family. Expecting the integers to match is an argument from the language specs in section 9, not a CGP result |
| E. Network determinism | Two machines advance from one input sequence and stay aligned | Not implemented. No transport, no shared clock, no remote input |
| F. Rollback and resimulation | Restore an earlier authority and re-execute later steps without hidden state | Not implemented. Slice restore can put the ledger and the witness back to a document that was valid when captured. It does not re-execute. It does not include scratch, unsaved module memory, or the input list. A refused step does not undo scratch |

The recommendation in section 12 does not aim at E or F.

## 7. Concern matrix

Status: **A** implemented and tested, **B** partial, **C** not implemented, **D** unsafe to infer. Enforcement is where the rule actually lives, not where a comment hopes it lives.

| Concern | Status | Enforcement | Evidence | Risk if left implicit |
|---|---|---|---|---|
| One caller, one tick, no runner loop | A | Runner, outside Foundations | `sim.ts`; timer scan in `sim.test.ts` | A later "frame loop" gets mistaken for a Foundation |
| Next tick only, delta 1..10000 | A | Runner, and the ledger again on commit | Idle and skip tests; `commitEntities` | A caller-supplied delta gets described as a fixed internal clock |
| Contribution order `(order, moduleId, id)` | A | Host sort at registration | `contributionSort`; package-reversal test | Package order gets treated as simulation order |
| Ledger checks open step, entity set, range | A | Ledger module | Direct-call test | The runner gets treated as the only gate |
| Runner is the only writer | B | Not enforced. Direct commit is legal | Steal test; ADR 0016 | Tools assume every tick was a full proposal plus a completion event |
| Proposal failure leaves positions | A | Ledger abort | Halt and skew tests | — |
| Scratch rolled back on failure | C | Not enforced. The limitation is tested | `scratch.n` stays 1; ADR 0016 | Authors treat the pipeline as a transaction |
| Completion only after runner commit | A for the runner path | Runner `publish` | Direct commit leaves `heard` empty | A witness is treated as proof that the proposal ran |
| Subscriber failure keeps the tick | A | `publish` isolates throws | Break-subscriber test | Callers retry a tick that already committed |
| `sim.read` can observe a committed tick before subscribers | A | Lane rules: read is non-mutating | Snapshot test reads tick 1 while `heard` is empty | A diagnostic read is treated as a consistent save |
| Capture waits for the step and for in-step mutations | A | `runExclusive` plus direct-mutation notes | Capture-during-step tests | — |
| Save omits `open` and refuses restore while open | A | Ledger `exportState` / `importState`, host slice rollback | Direct-open restore test | A crash mid-step is imagined to resume the proposal |
| Save pins the composition | B | Warning only | `save.ts` `save.fingerprint` | A restore onto other modules looks like a replay |
| Cross-slice agreement | C | Not enforced | Steal save is a legal document: tick 1, `heard` empty | A restored witness is used to audit the proposal |
| Persisted input log | C | None | Requests die with the call | Demos and divergence checks get built on slices alone |
| RNG stream | C | None in this proof | No `Math.random` under `src/` | A future global seed is assumed to be replay |
| Float bit-identity | D | Not claimed | ADR 0015 last paragraph | The integer tests get cited as a float result |
| Cross-OS integer agreement | D | Not run | Node and Chromium only | Spec exactness gets reported as a matrix result |
| Network lockstep or rollback | C | None | No protocol | The lane gets described as prediction |
| Async completion mutates the ledger | C in production | Study 013 lane is prototype-only | Study 013 section 6 | A WASI `async func` gets wired to `sim.commit` |
| State hash | C | None | — | A hash of one slice gets called a full-state hash |

## 8. External architectures

Observation is separated from the CGP reading. Versions are the revisions actually fetched on 2026-11-20.

### 8.1 Bevy, fixed step beside the earlier scheduling study

[Bevy study 003](../bevy/003-ecs-data-ownership-scheduling-and-state-boundaries.md) pinned [7ea4827e16d5d50d48e22d9a249c554ad073f38a](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a) (2026-11-13, workspace 0.20.0-dev) and covered access conflicts, the multithreaded executor, command buffers, and change ticks. This study does not repeat that. It re-read two files at the same revision:

- [`crates/bevy_time/src/fixed.rs`](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_time/src/fixed.rs)
- [`crates/bevy_app/src/main_schedule.rs`](https://github.com/bevyengine/bevy/blob/7ea4827e16d5d50d48e22d9a249c554ad073f38a/crates/bevy_app/src/main_schedule.rs)

Observed in those files:

- `Time<Fixed>` follows virtual time. The default timestep is 64 Hz, 15625 microseconds. The comment gives two reasons: a 60 Hz step can alternate between two fixed updates and zero against a display refresh, and 15625 microseconds is a power of two that converts into `f32` and `f64` without rounding.
- `FixedUpdate` runs from accumulated overstep. The schedule may run 0, 1, or more times during one render update.
- `RunFixedMainLoop` runs `FixedMain` until the relevant elapsed time is consumed. Systems added directly to `RunFixedMainLoop` are not parallelized with each other. `FixedUpdate` is the documented place for physics, AI, networking, and game rules. `Update` is the documented place for UI, input handling, and audio control.
- The fixed schedule is still a Bevy schedule. Study 003's finding stands for it: an explicit partial order plus a parallel executor is not one total simulation order.

CGP fit: the split between simulation steps and presentation work is the useful idea. CGP already has the split in a weaker form, because nothing renders. The caller, not a clock plugin, decides how many integer steps occur.

Do not copy: Bevy's app runner, the 64 Hz default, catch-up from wall or virtual time, `Local<T>` as hidden system memory, command buffers that apply trusted `World` mutations, or the multithreaded executor. A fixed-timestep helper, if a game later wants one, should sit outside Foundations and call `advanceSimulation`.

### 8.2 Doom: input per tic, version-sensitive resimulation

Historical sources as published in [id-Software/DOOM `a77dfb96`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0) (GitHub commit 2024-01-16; the tree is Linux Doom 1.10, `VERSION` 110):

- [`linuxdoom-1.10/doomdef.h`](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/doomdef.h) defines `TICRATE` as 35.
- [`linuxdoom-1.10/d_ticcmd.h`](https://github.com/id-Software/DOOM/blob/a77dfb96cb91780ca334d0d4cfd86957558007e0/linuxdoom-1.10/d_ticcmd.h) defines `ticcmd_t` as the data sampled per tick and transmitted to peers: `forwardmove`, `sidemove`, `angleturn`, `consistancy`, `chatchar`, `buttons`. The comment calls `consistancy` a checksum for net-game state.

[DoomWiki's demo page](https://doomwiki.org/wiki/Demo), retrieved 2026-11-20, is secondary. It describes a demo as a sequence of those tic commands, and it says playback usually requires the same executable version and the same WAD. That page is not id's specification. It matches the struct above enough to support one conclusion: Doom's demo is an input log plus an implicit engine identity, not a recording of every position.

CGP fit: an ordered input record, and a version identity that refuses or at least flags a different composition. CGP's fingerprint is already that identity. Restore does not enforce it.

Do not copy: the 35 Hz rate, the `ticcmd_t` layout, fixed-point rendering, the consistency short as a CGP hash, or lockstep networking.

### 8.3 Quake 1: a demo can be a message log instead

[id-Software/Quake `bf4ac424`](https://github.com/id-Software/Quake/commit/bf4ac424ce754894ac8f1dae6a3981954bc9852d) (2012-01-31), [`WinQuake/cl_demo.c`](https://github.com/id-Software/Quake/blob/bf4ac424ce754894ac8f1dae6a3981954bc9852d/WinQuake/cl_demo.c): `CL_WriteDemoMessage` writes the current net message length, three view angles, and `net_message`. Recording calls that function when a server message arrives. This study did not find player usercmds in that write.

Observed fact: a Quake demo, in this file, is a client recording of server messages plus view angles. It is not the Doom input log. Replaying it does not prove the server resimulated from inputs.

Do not copy this shape as CGP's replay format. A log of accepted ledger snapshots would not detect a divergent proposal. It would only redraw the snapshots.

### 8.4 Source prediction is correction against a server

The live Valve wiki page did not return article text on 2026-11-20 (bot check). The source used here is the Internet Archive capture of [Source Multiplayer Networking](https://web.archive.org/web/20080915214033/http://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking) from 2008-09-15. That page says:

- With `cl_predict 1`, the client predicts its own usercmds instead of waiting for the server.
- The server still sees the old place until the snapshot arrives.
- The client compares that snapshot with the prediction. On a mismatch it corrects, because the server has final authority.
- Prediction works for the local player and the weapons it controls, and only if the client knows the same rules and state.

That is not a demo format, and it is not a claim that every entity is resimulated on every client. Lag compensation is a further server-side rewind. This study does not need it, and does not treat the 2008 page as the current Source source code.

CGP fit, later and only if a networked game exists: authority stays in one ledger; a predicted copy is not that ledger; correction replaces or replays the copy. Foundations should not learn usercmds.

Do not copy: client authority over hits, smoothing of prediction error, or interpolation of other entities. Those are presentation and netcode.

### 8.5 GGPO rollback

[pond3r/ggpo `7ddadef`](https://github.com/pond3r/ggpo/commit/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a) (2019-11-07), [`doc/DeveloperGuide.md`](https://github.com/pond3r/ggpo/blob/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a/doc/DeveloperGuide.md), states requirements rather than a hidden engine guarantee:

- The game must save, load, and advance one simulation frame without rendering that frame.
- `ggpo_synchronize_inputs` is called every frame, including frames that are part of a rollback, and the game advances from those values rather than from the raw controller.
- Effects and sounds generated during a rollback are deferred until the rollback finishes.

GGPO is an input-delay plus speculative-resimulation library. It assumes the title can restore a complete simulation and step it again, deterministically, with rendering held aside. CGP cannot meet that assumption today. Slice restore misses scratch and unsaved memory, and there is no input journal. Building GGPO-shaped APIs now would invent a netcode product on top of a proof that has no second machine.

Do not copy: frame delay, prediction of remote inputs, or a sync-test harness, until a game has a complete authoritative snapshot and a reason to roll it back. The sync-test idea (save, step, load, step, compare) is the one piece worth remembering, and it can be applied to the integer ledger without the network.

### 8.6 Unity fixed update and Entities catch-up

[Unity 6.3 manual, fixed updates](https://docs.unity.com/en-us/engine/6000.3/manual/scripting/managing-time-and-frame-rate/fixed-updates), retrieved 2026-11-20: a fixed update is a configurable interval; one rendered frame may have to run several fixed steps to catch up; there is a maximum interval beyond which Unity stops catching up.

The Entities script reference page [FixedStepSimulationSystemGroup](https://docs.unity.com/en-us/engine/7000.0/script-reference/unity/entities/fixedstepsimulationsystemgroup), labeled Unity.Entities 7000.0 and retrieved the same day, says the group overrides elapsed time and delta while it updates, runs as many steps as needed to catch up, and defaults to 1/60 second. This study did not read the package source. The page is the documentation, not an observation of a binary.

Do not copy the catch-up loop into Foundations. Missed frames, pauses, and time scale are game policy. A platform default would be an invisible input.

### 8.7 WebAssembly numbers, and JavaScript numbers

[WebAssembly Specification, Release 3.0 (2026-11-16)](https://webassembly.github.io/spec/core/_download/WebAssembly.pdf), section 4.3.3: floating-point operators use round-to-nearest ties-to-even, non-stop mode, and no observable exception flags. NaN payloads are not fully determined. If every NaN input is canonical, the output payload is canonical; otherwise the payload is chosen from the arithmetic NaNs, and the sign is non-deterministic. Integer Wasm operations used by the boundary guest are not in that NaN rule.

The [relaxed-simd proposal](https://github.com/WebAssembly/relaxed-simd/blob/c3f9359af2cd607cc46b0a3274f90ea52543a2f2/proposals/relaxed-simd/Overview.md) at `c3f9359` (2024-07-18) says those instructions are locally non-deterministic and may differ by hardware. The boundary guest does not use them. A future guest that does would leave level C and D by construction.

[ECMAScript 2025](https://tc39.es/ecma262/2025/), section 21.3.2: `Math.sin`, `Math.pow`, and the other transcendental functions listed there are implementation-approximated, aside from specified edge cases. Addition and multiplication are IEEE 754 binary64 operations. For the values this proof accepts, that matters. Movement computes `entity.x + vx * delta` and then rejects a result outside signed 32-bit. Delta is at most 10000 and each factor fits in signed 32-bit, so the product's magnitude is at most `2147483647 * 10000`, which is less than `2^53`. Integers in that range are exactly representable. The boundary guest then clamps with signed `i32` compares, not with `f32`. The Node and Chromium agreement is agreement on that integer pipeline. It is not evidence about `Math.sin`, about `f32` contraction, or about NaN bits.

## 9. Authority, time, randomness, and asynchronous work

### 9.1 State authority

The ledger module is the authority for positions and tick in this proof. Simulation Core only declares the slots. The host does not interpret a move.

Each future simulation domain should own its own ledger module, or an equivalent service with an explicit commit. One platform-wide world would put entities, vectors, and game rules into Foundations. ADR 0009 already refused that for records. This study refuses it again for positions.

Multiple systems should keep returning proposals. The current fold is a total order, which is enough while every stage is awaited before the next starts. It stops being enough if two stages run at once and both read state the other writes. Bevy's answer is access metadata and a parallel executor that still allows more than one legal order. CGP should not take that answer until a profile needs the throughput. Until then, missing order is a bug in the contribution ids, and the total sort already exposes it: equal order falls through to `moduleId`, then id, so the order is stable but may not be the order the authors meant. A diagnostic that warns on equal `order` values would make that visible. It is not required for the current two-stage proof.

A module that mutates private state during the proposal is outside the guarantee, even if the ledger later aborts. CGP can say that without becoming a transaction manager. The rule is: do not keep step-local writes except in the returned proposal; record committed facts from `sim.completed`; export anything that must survive save. The host will not police arbitrary memory.

### 9.2 Ordering if execution ever becomes parallel

Necessary for this proof: one total order of proposal stages, one commit, subscribers after that commit. The implementation has that, for a single-threaded await loop.

Not provided, and not needed yet: read/write sets, conflict errors, deterministic reduction of parallel results, or a rule for which stage sees which other stage's scratch. Adding threads without those rules would drop level A for any pair of systems that touch the same data.

### 9.3 Time

Wall-clock time, frame time, and simulation time are different. Today only the caller-supplied integer delta is simulation time, and only for the arithmetic above. There is no frame time. The isolate's `Date.now` is a budget, not a tick.

Ticks should stay integer identifiers. The delta can remain a duration in caller units. This proof uses delta as a multiplier, so two calls with delta 4 are not the same state sequence as eight calls with delta 1 once clamping has happened. The test `stays put` uses delta 4 once and expects `e1` at `(12, 0)` from `(0, 0)` with `vx` 3 and `vy` -1, because the boundary clamps `y` from -4 to 0. That is a checked integer, not a sampled integral of a frame.

Missed frames, pause, catch-up, and time scale should stay in a caller or a future runner library. Foundations should not grow a `FixedUpdate`.

### 9.4 Randomness

No RNG service exists, and the proof does not need one. If a later module needs randomness:

- That module should own the stream and the seed.
- The seed and the stream state should be in its save slice.
- Draws that affect the ledger should happen inside the ordered step, not in a subscriber that might be skipped by a direct commit.
- A second module should not consume the first module's stream.
- A global seed does not survive an inserted system that draws once more, or a reordering of equal `order` values.

This study does not choose PCG, xoshiro, or any other algorithm. The ownership rule matters before the algorithm does.

### 9.5 Floating point

Authoritative gameplay state in this proof is integers, and that is the right restriction to keep documenting. Fixed-point or integer units are appropriate for a future authoritative position if the game needs more range than 0..1000. That wider range would be a new module contract, not a host type.

Floating point is acceptable for presentation that does not feed the ledger. It is not acceptable as an unstated authority format. Wasm NaN rules and ECMAScript `Math.*` are the reasons. A documented restriction ("this profile's authority is integers" or "this profile's authority is IEEE-754 binary64 add/mul/div/sqrt only, no NaN, no relaxed SIMD, no `Math.sin`") is honest. A promise of bit-identical results across engines, without those limits and without a matrix, is not.

### 9.6 Asynchronous work

Production pipeline stages may return promises. `callHandler` awaits each one before the next stage. Stage order stays the contribution order even when a stage is async. What the stage reads while it waits is not ordered. A network response, a file read, or `Date.now` inside that wait becomes an unrecorded input.

Study 013's prototype lane is the right boundary for a completion that arrives later, and it is not this ledger. Proposals there apply on commit, cancel drops them, and a late completion after cancel or shutdown does not apply. Cancellation is cooperative. It is not a rollback of guest memory. Node 22 cannot run the jco async glue. Making a WASI 0.3 `async func` the simulation interface would let completion order depend on the runtime. That recommendation stands.

External results should enter the authoritative simulation as ordinary fields on a later `advanceSimulation` request. They should not call `sim.commit` from a socket callback. The caller assigns them to a tick. Replay feeds the same assignment back.

Work that does not change the ledger can stay outside the step. The witness is the example: it runs after commit, and a failure there does not undo the tick. That is safe only because the witness is not authority.

## 10. Snapshots, replay, and hashes

A complete snapshot of this proof is not the save document.

The save document has `foundationsApi`, `profileName`, `fingerprint`, and one slice per exporting module. The ledger slice is authority for positions. The witness slice is a completion trace. Together they are not a replay:

- Drives and deltas are absent.
- `open` is absent, which is correct.
- A fingerprint mismatch warns (`Document fingerprint does not match this composition. Slices are still matched by module id.`) and restore continues.
- Two slices can disagree. The steal test saves tick 1 with `heard: []`.
- A module that mutated memory and does not export it is absent. Restoring the ledger does not repair it.
- Object keys are sorted. Array order is kept. A hash of the JSON text would move if key order were not canonical. The save path already sorts keys. A hash that ignored that would report a false divergence.

A replay log, if built, should contain the composition fingerprint (backend id, module id and version in dependency order, slots, dependencies, contribution order), the initial ledger slice, and the ordered requests `{tick, delta, inputs}`. It may also contain external results that the caller folded into those inputs. It should not contain presentation, and it should not contain rejected proposals.

A state hash, if built, should name its coverage. A hash of the ledger slice compares authority. A hash of every save slice compares the exported document, including the witness, and will differ when a direct commit skipped completion. A hash of process memory is not available and would not be stable. None of these hashes exist today. Building one before the log exists would bless the incomplete snapshot.

Divergence diagnosis needs the fingerprint first. A different module version or a different contribution order is a different program. It is not a numeric bug.

## 11. Failure scenarios

| Scenario | Today | Prevented? | Severity for the intended platform | Smallest mitigation |
|---|---|---|---|---|
| A system increments private state, a later system throws | Happens. `scratch.n` stays 1, ledger stays at the previous tick, `heard` stays empty | Ledger yes, scratch no | High if authors store gameplay in scratch. Low if they follow ADR 0016 | Keep the written rule. A later test helper can compare `exportState` before and after a refused step. Not a transaction framework |
| A subscriber throws after commit | Happens. Tick stays, the failure is listed, other subscribers still run | Rollback is intentionally absent | Low. The result already tells the caller | Do not retry the same tick. Record from a subscriber that can fail without being the only copy of authority |
| Two modules assume different orders | Stable host order may not be the intended order when `order` ties | The sort is total, so it is repeatable, not necessarily meaningful | Medium once more than the move/bound pair exists | Keep explicit `order` values. A warning on ties can wait |
| A float differs across engines | Not in this proof | Not applicable to the integer path | High if a future authority value is an unrestricted float | Keep authority integral until a profile states its numeric subset |
| An async result arrives in a different order on replay | Not in the production sim path. Possible if a stage waits on I/O | Not prevented for trusted JavaScript | High if a module does it. The proof modules do not | External results become caller inputs. Do not adopt Study 013's WASI async export as the sim ABI |
| Inserting a module changes an RNG stream | No RNG exists | Nothing to prevent later | High on the day a shared stream appears | Per-module streams in module state, not a Foundations global |
| Save captures the ledger and misses other mutated state | True for any module without `exportState`, and for scratch | The host only stores exported slices | High for a module that thinks `ctx.keep` is saved automatically | Export the state that must return. The host should not scan memory |
| Replay on another contribution order | The in-memory tests do not replay from a file. A save would warn and still apply | Not refused | High for a demo, low until demos exist | Put the fingerprint in the replay header and fail the check on mismatch |
| A module reads the wall clock or the network | JavaScript on the cross backend is trusted and unlimited. The proof modules do not | Not prevented | High for that module's results. Isolated from the ledger only if the module does not commit | Same input rule. Do not pretend the JS half is a sandbox |
| Restore shows the right positions and the wrong hidden state | True whenever hidden state was not in the document, or the witness was skipped | Not detected | Medium now, because the only hidden sim state is small and mostly exported | The re-execution check compares the ledger. It will not see hidden state the systems do not export. That limit should stay written |

The isolate budget is a related, already implemented behavior. A boundary call slower than `maxHookMs` stops the guest. The same inputs can then fail on a slow machine and succeed on a fast one. Positions are not partially updated by that path if the commit has not happened. This is not a second simulation result. It is a reason not to describe every failed step as a deterministic rejection.

## 12. Recommended contract

Research recommendation only. Not an accepted decision.

### Keep, and do not move into Foundations

- Caller-driven `advanceSimulation`, one integer tick per call, no timer in the runner.
- Ledger-owned authority, open / abort / commit, range and entity-set checks.
- Total contribution order for the synchronous proposal pipeline.
- Completion only after the runner's commit, with subscriber failures isolated.
- Save slices owned by modules. `open` stays out of the slice.
- One lane for advance, seed, restore, capture, and mutating services. Reads stay off the lane, and callers must not treat a mid-step read as a save.
- The integer proof as the only determinism claim: same ledger, same delta, same inputs, same ordered modules, same positions. No bit-identical floats.
- `cgp.abi/1` and the Study 013 conclusion that a second component runtime is not the production guest ABI.

### Put in modules or a library, not in the host

- A future fixed-step caller that turns frame time into zero or more `advanceSimulation` calls.
- Per-module RNG state, when a game needs it.
- Presentation, interpolation, audio, and input devices.
- An opt-in replay log and a re-execution check.

### Optional later

- A tie warning when two contributions share an `order`.
- A hash of the ledger slice, or of the full save document, with the coverage written next to the hash.
- A stronger determinism profile that lists allowed numeric operations. Off by default.
- Prediction against a copy of the ledger, only after a networked game needs it and only outside Foundations.

### Outside CGP

- Lockstep transport, rollback netcode, lag compensation, client-hit authority.
- A general prepare/commit/abort protocol for arbitrary module memory.
- A platform-wide 64 Hz or 35 Hz or 1/60 second clock.
- Bit-identical `Math.sin` or relaxed SIMD.
- Making Foundations parse entities or moves.

### Answers

**What CGP already guarantees.** For the reference composition, a caller who repeats the same integer requests gets the same positions and tick. The order of systems does not follow package order. A failed proposal does not move the ledger. A subscriber failure does not either. Node and Chromium have both been observed to do this, including across save and restore. The runner does not advance time by itself.

**What is missing.** A persisted input sequence. Enforcement that the composition fingerprint matches before a restore is treated as the same run. Rollback of scratch. A hash. An RNG model. Any cross-OS run. Any network run. Any float claim.

**What matters before a reference game.** The persisted input record and a local re-execution check. Authors also need the scratch rule to stay visible, because a game module that hides state in a closure will make that check lie. A Foundations scheduler does not matter yet. Neither does rollback.

**What stays unchanged.** ADR 0015, ADR 0016, the production ABI, the lane, the ledger's right to refuse a bad commit, and the decision that direct commit is not a sandbox violation.

**Smallest next implementation milestone.** Do not start it from this study. When it is scheduled, build it outside Foundations: a log of `{fingerprint, initial ledger slice, ordered requests}` and a checker that loads the same packages, restores the initial slice, re-issues the requests, and compares the ledger slice. Include one case where a scratchful system makes that comparison insufficient, so the limit stays tested. No sockets, no hash of process memory, no new host service.

**What waits for a demonstrated need.** Fixed-step catch-up policy, RNG helpers, state hashes beyond the ledger, prediction, reconciliation, parallel systems, and every item under "Outside CGP".

## 13. Explicitly rejected or premature

- A generic ECS, Bevy schedule graph, or command-buffer transaction story.
- Physics, collision, or a spatial model beyond the modules' 0..1000 contract.
- Client-side prediction, GGPO, or lockstep as a platform mode.
- A self-advancing scheduler in Foundations or in Simulation Core.
- A floating-point determinism mandate.
- Replacing `cgp.abi/1` or reopening Study 013's async conclusion.
- Quake-style message logs as the definition of replay.
- Doom's tic format, consistency short, or 35 Hz rate as a CGP constant.
- Unity's catch-up loop as default time.
- An RNG service that every module silently shares.
- A transaction manager whose job is to snapshot arbitrary JavaScript closures.

## 14. Unresolved questions

Secondary gaps, none of which authorize implementation:

- Whether a tie on contribution `order` should warn. The sort is already deterministic.
- Whether restore should grow a strict mode that refuses a fingerprint mismatch. Today it warns. Changing that is a save-contract change, not a conclusion of this study.
- How large a numeric profile would have to be before any authoritative float is worth allowing.
- Which exported slices, besides the ledger, a particular game would have to list before the re-execution check is meaningful. That depends on the game's modules.

**Next research question.** What is the smallest log, stored outside Foundations, that lets a second process with the same packages re-execute this integer ledger from tick 0 and flag a divergence, and which non-exported module state would still make that flag a false match?

That question is the gate for the milestone in section 12. It is not a request to build the log, a hash, or a netcode stack.

## 15. Sources and revisions

CGP baseline: [`f85ccbbea2b7a2872dce2b1abf17781438f75560`](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/f85ccbbea2b7a2872dce2b1abf17781438f75560), 2026-11-20.

External revisions fetched 2026-11-20:

| Source | Revision | What was used |
|---|---|---|
| Bevy | [`7ea4827`](https://github.com/bevyengine/bevy/commit/7ea4827e16d5d50d48e22d9a249c554ad073f38a), 2026-11-13 | `fixed.rs`, `main_schedule.rs`. Same pin as Bevy study 003. Scheduling conclusions are not re-derived here |
| id Software Doom sources | [`a77dfb96`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0), 2024-01-16 | `TICRATE`, `ticcmd_t` |
| DoomWiki demo article | Retrieved 2026-11-20, not a pinned source | Secondary description of demo compatibility. Not treated as engine source |
| id Software Quake sources | [`bf4ac424`](https://github.com/id-Software/Quake/commit/bf4ac424ce754894ac8f1dae6a3981954bc9852d), 2012-01-31 | `CL_WriteDemoMessage` |
| Valve Source Multiplayer Networking | Archive 2008-09-15 | Prediction versus server authority. Live wiki text was not available |
| GGPO | [`7ddadef`](https://github.com/pond3r/ggpo/commit/7ddadef8546a7d99ff0b3530c6056bc8ee4b9c0a), 2019-11-07 | Developer guide requirements on save, load, and `ggpo_synchronize_inputs` |
| Unity manual 6000.3 | Retrieved 2026-11-20 | Fixed updates and catch-up |
| Unity Entities `FixedStepSimulationSystemGroup` | Docs labeled 7000.0, retrieved 2026-11-20 | Documented catch-up group. Package source not read |
| WebAssembly spec | Release 3.0, 2026-11-16 | Floating-point NaN rule |
| Relaxed SIMD proposal | [`c3f9359`](https://github.com/WebAssembly/relaxed-simd/commit/c3f9359af2cd607cc46b0a3274f90ea52543a2f2), 2024-07-18 | Local non-determinism |
| ECMAScript 2025 | [tc39.es/ecma262/2025](https://tc39.es/ecma262/2025/) section 21.3.2 | Implementation-approximated `Math` functions |

Bevy study 003 remains the record for access conflicts, command buffers, and the multithreaded executor. This study only extends that pin into fixed timestep, replay boundaries, asynchronous completion, and cross-runtime numeric limits.
