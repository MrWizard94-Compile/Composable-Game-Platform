# WIT compatibility prototype

Isolated Study 013 experiment. It does not change `cgp.abi/1`, package schemas, or project activation.

The host still owns module identity, slot kind, contribution order, explicit provider selection, and composition-scoped authorization. The WIT package version is not a CGP module version.

## Run

Node 22 or newer, Rust 1.99.0, and the pinned CLI tools:

```sh
CGP_WIT_TOOLS=/tmp/cgp-wit-tools/bin sh tools/install.sh
npm ci
npm test
```

`npm test` builds both guests, runs the same conformance vectors on Wasmtime, Node (jco transpile), Chromium, and Firefox, then runs the separate async probe. Set `CGP_REQUIRE_FIREFOX=1` when Firefox must pass. This sandbox cannot launch Firefox; Chromium can.

`npm run measure` writes `measurements.json`. It imports the production ABI read-only.

## Layout

- `wit/slot-probe.wit` is the sync slot contract.
- `wit/hostile.wit` imports `hostile-io` and must be refused before instantiation.
- `wit/async-probe.wit` is not the slot ABI.
- `guests/rust-meter` and `guests/js-meter` implement the same world.
- `host/policy.mjs` is the CGP-shaped policy shared by Node and the browser.
- `harness/wasmtime-host` executes the component binary.

Browsers and Node execute the jco output: core Wasm plus JavaScript. They do not execute the component binary. Wasmtime does.
