import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guestFromContributions, templateGuest, type GuestContribution } from "../src/foundations/wasm-build.ts";
import { duneWasmBytes } from "../src/modules/org.cgp.dune-growth/bytes.ts";
import { duneGrowthGuest } from "../src/modules/org.cgp.dune-growth/guest.ts";
import { boundWasmBytes } from "../src/modules/org.cgp.sim-bound/bytes.ts";
import { boundGuest } from "../src/modules/org.cgp.sim-bound/guest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

const dune = duneGrowthGuest();
const bound = boundGuest();
const shipped = new Uint8Array(readFileSync(join(root, "src/modules/org.cgp.dune-growth/module.wasm")));
const boundShipped = new Uint8Array(readFileSync(join(root, "src/modules/org.cgp.sim-bound/module.wasm")));
const template = templateGuest();
const example = new Uint8Array(readFileSync(join(root, "examples/wasm-module/module.wasm")));
const thirdPartyDir = join(root, "examples/third-party-module");
const thirdSpec = JSON.parse(readFileSync(join(thirdPartyDir, "guest.json"), "utf8")) as { contributions: GuestContribution[] };
const thirdBuilt = guestFromContributions(thirdSpec.contributions);
const thirdShipped = new Uint8Array(readFileSync(join(thirdPartyDir, "module.wasm")));

if (!same(dune, duneWasmBytes) || !same(dune, shipped)) {
  console.error("Dune guest bytes do not match module.wasm or bytes.ts. Regenerate both from duneGrowthGuest().");
  process.exit(1);
}
if (!same(bound, boundWasmBytes) || !same(bound, boundShipped)) {
  console.error("Boundary guest bytes do not match module.wasm or bytes.ts. Regenerate both from boundGuest().");
  process.exit(1);
}
if (!same(template, example)) {
  console.error("examples/wasm-module/module.wasm does not match templateGuest().");
  process.exit(1);
}
if (!same(thirdBuilt, thirdShipped)) {
  console.error("examples/third-party-module/module.wasm does not match guest.json. Run scripts/build-wasm-module.ts.");
  process.exit(1);
}
console.log(
  `wasm ok  dune ${dune.byteLength} bytes  boundary ${bound.byteLength} bytes  template ${template.byteLength} bytes  third-party ${thirdShipped.byteLength} bytes`,
);
