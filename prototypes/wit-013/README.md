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

`npm test` builds both guests, runs the same synchronous conformance vectors on Wasmtime, Node (jco transpile), Chromium, and Firefox, then runs `async-probe.mjs`. That probe is not the slot suite. It requires Wasmtime to print `ok("pong")`, requires jco transpilation to succeed, requires Node 22 to fail with `WebAssembly.promising is not a function`, and requires Chromium to resolve `tick` to `pong`. A different Node 22 error fails the probe. Set `CGP_REQUIRE_FIREFOX=1` when Firefox must pass the synchronous suite. The authoring sandbox cannot launch Firefox. Chromium can. GitHub Actions installs the missing libraries and requires Firefox there. Browsers execute the jco output, not the component binary.

`npm run measure` rewrites `measurements.json` for the machine it runs on. The committed file is the authoring-sandbox run. Do not paste another machine's timings into it.

## Layout

- `wit/slot-probe.wit` is the sync slot contract.
- `wit/hostile.wit` imports `hostile-io` and must be refused before instantiation.
- `wit/async-probe.wit` is not the slot ABI.
- `guests/rust-meter` and `guests/js-meter` implement the same world.
- `host/policy.mjs` is the CGP-shaped policy shared by Node and the browser.
- `harness/wasmtime-host` executes the component binary.

Browsers and Node execute the jco output: core Wasm plus JavaScript. They do not execute the component binary. Wasmtime does.
