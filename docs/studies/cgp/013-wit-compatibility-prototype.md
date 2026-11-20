# Study 013 — WIT compatibility prototype

Date: 2026-11-20. Repository baseline before this study: `9ba3b35c0f884064bc07a382b4713c3bfbb95cc1`.

This is a research prototype. It is not an ADR, not a package-schema change, and not a migration of `cgp.abi/1`. Production activation, the core-module release format, and the existing tests are unchanged.

## 1. Question

Can one small WIT contract be implemented twice, in Rust and in JavaScript, and then executed from the same component bytes on Wasmtime, on the Node versions CGP actually supports, and in more than one browser, without giving away CGP's module identity, slot rules, authorization, or deterministic mutation?

[Study wasmCloud 002](../wasmcloud/002-component-model-and-wit.md) said to answer that before treating WIT as a guest ABI. [ADR 0020](../../adr/0020-cross-language-modules.md) still says a guest is unlabeled WebAssembly and the host copies JSON. This study keeps that boundary and measures the alternative beside it.

## 2. What runs where

CGP's production guest ABI is `cgp.abi/1`: a core module, not a component. The host copies UTF-8 JSON in and out. Handles are minted per composition. The JSON fields are not the capability. A copied object is not callable, and a handle from another composition does not enter the guest. Node and Chromium already observe that interchange. The package check in ADR 0017 is a core module. An authoring tree may contain WIT. That WIT is not the release.

The supported runtime floor is Node `>=22`. This run used Node 22.23.3. Foundations CI tests Node 22 and Chromium. Windows and macOS CI do not activate JavaScript projects. Nothing in that matrix executes a WebAssembly component.

Three different things happened in this prototype:

| Path | What actually executed |
|---|---|
| Wasmtime 50.0.3 | The component binary, native component instantiation |
| Node 22.23.3 | `@bytecodealliance/jco` 1.42.0 transpilation: JavaScript plus core Wasm. Not the component binary |
| Chromium via Playwright 1.64.0 | The same transpiled JavaScript and core Wasm. Not the component binary |

Firefox 157 was downloaded. It did not start. The process lacks `libgtk-3.so.0`, `libgdk-3.so.0`, `libXcursor.so.1`, `libpangocairo-1.0.so.0`, `libcairo-gobject.so.2`, and `libgdk_pixbuf-2.0.so.0`, and this sandbox cannot install them. WebKit failed on `libgtk-4` and `libgstreamer`. The GitHub Actions job installs those libraries and treats Firefox as required. Until that job is green, Firefox is an unsupported platform for this run, not a passed browser.

## 3. Pinned toolchain

Selected because this combination built one sync world and ran it on all three paths. Not selected only because the numbers are recent. Exact pins, dates, licenses, and hashes are in [toolchain.json](../../../prototypes/wit-013/toolchain.json).

| Tool | Version | Published | License | Why this one |
|---|---|---|---|---|
| Wasmtime | 50.0.3 | 2026-11-19 | Apache-2.0 | Native component runtime on the line wasm-tools 1.263 already tracks |
| wasm-tools | 1.263.0 | 2026-10-30 | Apache-2.0 | `component new` and `component wit` for the bytes Wasmtime loads |
| wit-bindgen | 0.63.0 | 2026-10-14 | Apache-2.0 | Newest stable guest generator. No 0.64. Its wit-component is 0.262, one release behind wasm-tools 1.263 |
| `@bytecodealliance/jco` | 1.42.0 | 2026-11-13 | Apache-2.0 WITH LLVM-exception | The Node and browser path. Transpiles; it does not execute the component |
| `@bytecodealliance/componentize-js` | 0.23.0 | 2026-09-21 | Apache-2.0 | StarlingMonkey JS guest. Exact pin matches the backend jco 1.42 invokes. `--disable all` so the sync guest imports nothing |
| rustc / cargo | 1.99.0 | 2026-09-28 / 2026-08-27 | Rust project licenses | Host and `wasm32-unknown-unknown` guests. wit-bindgen 0.63 accepts this compiler |
| Node | 22.23.3 | — | Node.js | CGP's floor. Not a newer Node just because jco is tested on one |
| Playwright | 1.64.0 | — | Apache-2.0 | Chromium here. Firefox in CI |

The QuickJS componentize backend was rejected. It is async by default. `--backend-qjs-disable-async` would have been a second JS artifact, not the bytes Wasmtime and the browser share. StarlingMonkey with WASI features disabled produced one component with an empty import set, and that same file was transpiled.

The version skew is real: wit-bindgen 0.63 embeds wit-component 0.262, while wasm-tools is 1.263 and Wasmtime is 50.0.3. It was compatible for this sync world and for one `async func`. That is an observation about this contract, not a promise about a WASI 0.3 world.

These npm packages live in `prototypes/wit-013/package.json` only. The production dependency tree does not gain them.

## 4. Contract

`wit/slot-probe.wit` is package `cgp:slot-probe@0.1.0`.

- `meter` is the service surface: `calls`, `read`, `add`. Overflow returns `overflow` and does not change the stored value.
- `registry` returns contribution records. Identity is an explicit `id`. The guest does not decide membership or order.
- `passes` is a resource. `peek` borrows it and returns an owned string. `consume` takes ownership. `live` counts guest-side resources so destruction is observable.

The world exports those three interfaces and imports nothing.

That package version is not a CGP module id, not a module version, and not a composition id. The conformance vector keeps them distinct on purpose:

- WIT package `cgp:slot-probe@0.1.0`
- Rust module `org.example.rust-meter@1.4.2`
- JavaScript module `org.example.js-meter@2.0.1`
- Composition `comp-9`

WIT does not encode slot kind, `connectsTo`, duplicate contribution ids, explicit provider selection, or composition-scoped authorization. Those stay in `host/policy.mjs`, which is the same module the Node runner and the browser page import. The guests were not linked together with `wasm-tools compose`. Each one is instantiated alone. The host chooses.

`wit/hostile.wit` repeats the meter and imports `hostile-io.read-file`. A typed import is not a grant.

## 5. Guests

Both good guests export the same world.

Rust (`guests/rust-meter`) uses wit-bindgen 0.63, `crate-type = ["cdylib"]`, target `wasm32-unknown-unknown`, then `wasm-tools component new`. `wasm-tools component wit` shows no imports. Label `rust-meter`. Contributions, in the order the guest returns them: `rust-early` order 1, `shared` order 1, `alpha` order 20.

JavaScript (`guests/js-meter/guest.js`) is componentized with jco's default StarlingMonkey backend and `--disable all`. The component also has no imports. Label `js-meter`. Contributions: `js-early` order 1, `shared` order 1, `beta` order 10. `add` throws the string `overflow` or `refused`, which is the componentize-js encoding of `result<_, meter-error>`.

The hostile guest is Rust. `read` would call `read-file`. Nothing links that import. Wasmtime's instantiate error, truncated, was: `component imports instance cgp:slot-probe/hostile-io@0.1.0, but a matching implementation was not found in the linker`. The same refusal happens when the jco output is instantiated with an empty import object. No filesystem function is provided on any path.

Component sizes from `measurements.json`:

| Artifact | Bytes |
|---|---:|
| Rust component | 27,338 |
| Hostile component | 17,279 |
| JavaScript component | 12,028,656 |
| Transpiled Rust core Wasm | 22,135 |
| Transpiled Rust JS glue | 144,131 |
| Transpiled JavaScript core Wasm | 12,023,118 |
| Transpiled JavaScript JS glue | 147,354 |

The JavaScript component is about 11.5 MiB because the engine is inside the artifact. That cost is paid again in the browser as a core module of the same size. It is not a CGP module payload we should pretend is small.

## 6. Conformance

`host/vectors.mjs` is the vector list. `npm test` runs it against:

1. Wasmtime, both component binaries, through `harness/wasmtime-host`.
2. Node, both transpiled components.
3. Chromium, the same transpiled files, served to a page.
4. Firefox, when the browser can launch.

On this machine the first three passed, including resource, registry, lane, and hostile cases. Firefox did not launch. Case count is the same list on every path that ran. There were no skipped cases inside a path that started.

What the host, not WIT, decided:

- Two authorized service candidates and no explicit module id is `slot.ambiguous`. Neither guest's `calls` moves.
- An explicit id that is not an authorized candidate is `slot.missing`.
- A call with authorization false is `slot.unauthorized` and does not enter the guest. `calls` is unchanged. The other module stays at zero until it is selected.
- Selecting `org.example.rust-meter` adds on the Rust guest and leaves the JavaScript value and call count alone.
- Both guests contributing `shared` is `slot.duplicate-contribution`. The host does not pick a winner. That matches the production diagnostic in `src/foundations/host.ts` for a repeated `slotId:id`. It is not something the component linker did.
- After dropping both copies of `shared`, the remaining order is `(order, moduleId, id)`: `js-early`, `rust-early`, `beta`, `alpha`. JavaScript sorts before Rust because `org.example.js-meter` is lexicographically first.
- Marking the JavaScript module unauthorized removes its rows. `shared` is then unique and stays. The host excluded the contributor. The guest was not rewritten.

Meter behavior, both languages: read starts at 0 with the guest label; `add(3)` yields 3; `add(2147483647)` returns overflow and the next read is still 3.

Resources, both languages:

- `peek` on a borrow returns `js-0|org.example.js-meter|comp-9` or the Rust equivalent, and a later `consume` still succeeds. The borrow did not move the capability out.
- A second consume is `resource.stale`.
- The token `tok-forged` and the raw index `"1"` are `resource.forged`. The canonical handle index is not a CGP capability. This is the same rule as `cgp.abi/1`: the fields are not the brand. Production stores that brand in a `WeakMap` keyed by the composition. This prototype stores a composition-scoped token table. A guest that only knows an integer cannot present it.
- A token issued for one module, presented as the other, is `resource.cross-module` and is still consumable by the owner.
- A token presented with composition `comp-other` is `resource.cross-composition`.
- `drop` calls the guest destructor. `live` returns to the previous count on both the Rust component and the JavaScript component, on Wasmtime and on jco. Shutdown marks outstanding tokens dead. Later consume and commit return `composition.shutdown` and do not enter the meter.

Lane, on the JavaScript guest, with the Rust guest as the control that stays unentered until explicit selection:

- `propose` queues and does not call `add`.
- `cancel` drops the queue. The following commit applies nothing.
- An async completion only enqueues. `calls` does not move until `commit`. One completion applies once.
- Completing after `cancelAsync` does not apply on that commit or a later one.
- A failed completion does not change the value.
- Shutdown while a completion is pending drops it. A later commit does not apply it.

That lane is ordinary host state. It is not WASI 0.3, and it is not a guest export. The point of the test is that a completion which arrives on its own cannot mutate the meter.

## 7. Async, separately

`wit/async-probe.wit` is package `cgp:async-probe@0.1.0` with `tick: async func() -> result<string, string>`. The guest returns `"pong"` and does not suspend.

| Runtime | Result |
|---|---|
| wit-bindgen 0.63 | Generated an `async fn` and an `[async-lift]` export |
| wasm-tools 1.263 | `component wit` shows `tick: async func` |
| Wasmtime 50.0.3 `wasmtime run --invoke 'tick()'` | `ok("pong")` |
| jco transpile | Succeeded. The glue calls `WebAssembly.promising` |
| Node 22.23.3 | `TypeError: WebAssembly.promising is not a function` |
| Chromium (Playwright 1.64, no extra flag) | `tick` resolved to `pong` |

So a Component Model async export can run on Wasmtime 50 today, and this Chromium can run the jco glue, and the Node CGP supports cannot. JS Promise Integration is the missing piece on Node 22. jco's QuickJS note about `--backend-qjs-disable-async` is the same constraint from the other direction: a sync component still needs a host that is not forced through the async ABI. Node 22 is that host.

This probe does not show cancellation. There is no suspend point inside `tick`, so there is nothing to cancel. Component Model cancellation is cooperative. It is not a rollback of guest state, and a host that resumes a task does not have to resume it in call order. That is why the meter stays synchronous and the lane above is the only mutation path. Making WASI 0.3 `async func` the simulation interface would let completion order depend on the runtime. This prototype does not do that.

## 8. Measurements

Taken 2026-11-20 on Linux x86_64, Node 22.23.3. One thousand calls each. Wasmtime times are `std::time::Instant` inside the host process, so they do not include stdin. Node and Chromium times are `performance.now` around the call loop. RSS for Wasmtime is `VmRSS` of that process. Node RSS is the whole measure process and is not a clean per-guest number. Full JSON: [measurements.json](../../../prototypes/wit-013/measurements.json).

Build, warm crates, this machine:

| Step | Time |
|---|---:|
| Forced rebuild of both Rust guests, dependencies already compiled | 488 ms |
| `wasm-tools component new` for the Rust guest | 6 ms |
| componentize the JavaScript guest | 4,167 ms |
| jco transpile Rust / JavaScript / hostile | 667 ms / 1,260 ms / 552 ms |

The first Wasmtime 50 crate compile was minutes, not milliseconds. Later host links were about one second once the crate was built. That compile is a maintainer cost, not a per-module cost.

Call and instantiate:

| Path | Instantiate | 1,000 calls | Per call | Memory note |
|---|---:|---:|---:|---|
| Wasmtime, Rust component | 120 µs | 540 µs | 0.54 µs | VmRSS 2.7 MiB to 11.8 MiB |
| Wasmtime, JavaScript component | 3,718 µs | 11,008 µs | 11.0 µs | VmRSS 2.6 MiB to 314 MiB |
| Node jco, Rust transpile | 9.2 ms | 18.2 ms | 18.2 µs | Process RSS already ~161 MiB; about +7 MiB |
| Node jco, JavaScript transpile | 92.3 ms | 101.2 ms | 101 µs | About +42 MiB in that same process |
| Chromium, Rust transpile | 32.7 ms | 14.7 ms | 14.7 µs | Browser process, not separated |
| Chromium, JavaScript transpile | 117.3 ms | 92.3 ms | 92.3 µs | Loads the 11.5 MiB core module |
| `cgp.abi/1` `encodeAbiCall` only, in process | — | 2.0 ms | 2.0 µs | JSON codec, no guest |
| `cgp.abi/1` echo through `wasm-isolate` | 107 ms startup | 58.2 ms | 58.2 µs | Worker IPC included. One guest charged |

The production number is not an in-process WIT call. It is `compose` of `echoGuest()` from `src/foundations/wasm-build.ts` through `createWasmBackend()`, then one thousand `callPayload`s. Startup includes the worker. The 58 µs is the steady call, still crossing threads. The in-process JSON codec alone was 2 µs. A Rust WIT call inside Wasmtime was faster than both, at 0.54 µs, because it never left the process and never encoded JSON. A Rust call through jco in Node was 18 µs, still faster than the production worker echo, and still not the same work: `add(1)` versus a JSON echo. The comparison is still useful. The worker, not the JSON codec, is most of today's ABI cost. Replacing the ABI with WIT would not remove the browser's need for a JavaScript wrapper, and the JavaScript component's engine dominates both size and RSS.

Resource drop was not timed separately. `live` returning to the previous count is the functional measurement: destruction ran.

## 9. Three outcomes

### Full WIT guest ABI

The prototype can call the same service, registry, and resource contract from Rust and JavaScript on Wasmtime and, after transpilation, on Node 22 and Chromium. That is not enough to make WIT the production boundary.

Blocked by:

- Browsers do not run component binaries. Shipping WIT as the ABI means shipping jco's core Wasm and glue, and calling that a component would be false.
- Node 22 does not implement `WebAssembly.promising`. Async exports already fail there. CGP cannot assume a newer Node.
- The JavaScript component is 11.5 MiB and about 314 MiB RSS under Wasmtime. A module ABI that embeds an engine is not a replacement for a 27 KB Rust core module or for today's small `cgp.abi/1` guests.
- WIT does not know CGP module ids, composition ids, slot kinds, contribution order, duplicate ids, or authorization. The host policy would remain mandatory. The typed world would not be the security boundary.
- A WIT resource handle is not the production `WeakMap` brand. The prototype had to keep its own token table. Forgetting that and trusting the canonical index would be a capability bug.
- WASI 0.3 async is the wrong default for simulation. Completion is cooperative, not a rollback, and Node 22 cannot run the jco async glue.
- The toolchain is three CLI versions plus two npm packages, with a known wit-component skew. That is a lot of pin surface for every module author.
- Windows and macOS were not part of this run. Production activation CI on those systems would not cover a component toolchain unless we added one.

### WIT as a typed contract, adapters keep `cgp.abi/1`

Authors can write the slot surface in WIT. Generated bindings stay on the authoring side. The release is still a core module speaking JSON, or a JavaScript ESM module, exactly as ADR 0017 and ADR 0020 say. The adapter, not the linker, enforces order, selection, and the composition token.

This is the only option this prototype supports as a next step, and even that step is not authorized by the study. It needs a written adapter contract and tests that the generated JSON still round-trips through `wasm-isolate` and Chromium. Those tests were not the point of this run. The point was to see whether the typed world can sit beside the ABI without becoming it. It can.

Portability stays the portability CGP already has. Package complexity does not gain a component. Security stays the import allow-list and the handle brand. Performance stays the worker cost we measured, which is the cost browser isolation already pays. Developer experience gains typed guests only if someone later builds the adapter. Maintenance gains a document, not a second runtime.

### Server-side components only

Wasmtime ran the Rust component quickly and enforced the missing import. A future dedicated server could host components. Browsers would keep `cgp.abi/1`. Node 22 would keep the transpiled path or also keep the ABI.

That splits the guest boundary. Every slot rule would be implemented twice, once in the component host and once in the browser isolate, and they would drift. The JavaScript component's size makes a "components everywhere except the browser" story unattractive for JS modules even on the server: 314 MiB RSS for a meter. A Rust-only server component backend is the least bad form of this option, and it still leaves browser guests on the current ABI. This study does not start that backend.

## 10. Recommendation

Keep `cgp.abi/1`. Do not migrate the runtime.

WIT is usable as a typed description of a slot's functions, records, and resources. It is not usable as the authority for identity, registry order, provider selection, or composition-scoped handles. The evidence favors outcome 2, later, and only with adapters that still cross the existing ABI. Outcome 1 is rejected. Outcome 3 is not ruled out for a future Rust-on-Wasmtime server, but it is a second ABI and this prototype does not justify building it.

Failure points that remain even though the sync tests passed:

- Firefox did not run here.
- Node 22 cannot run the transpiled async export.
- The async guest never suspended, so cancellation was not observed inside a component.
- No Windows or macOS run.
- Component linking was not asked to reproduce slot semantics, and should not be assumed to.
- A borrowed handle cannot be stored in the Rust guest API because `PassBorrow` carries a lifetime. That was relied on, not compiled as a separate failing crate.

## 11. Unresolved

- Whether GitHub-hosted Firefox, after `playwright install --with-deps`, passes the same page. The workflow `wit-prototype` exists to answer that. This document does not claim it already did.
- Whether a future Node that implements JSPI should change CGP's floor. Today the floor is 22, and 22 fails the async glue.
- How large a real WASI 0.3 world is once it imports clocks, streams, and cancellation. This study refused that as the default interface.
- How an authoring adapter would lower this WIT world onto `cg_hook` without a new package schema.
- Whether StarlingMonkey can componentize a non-trivial guest without the 11.5 MiB engine, or whether JS modules should simply stay ESM and never become components.

The prototype is `prototypes/wit-013`. Reproducing it is `npm test` in that directory after `tools/install.sh`. It is not part of `npm test` at the repository root.
