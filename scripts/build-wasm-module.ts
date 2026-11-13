import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { templateGuest } from "../src/foundations/wasm-build.ts";
import { duneGrowthGuest } from "../src/modules/org.cgp.dune-growth/guest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dune = duneGrowthGuest();
const template = templateGuest();

writeFileSync(join(root, "examples/wasm-module/module.wasm"), template);
writeFileSync(join(root, "src/modules/org.cgp.dune-growth/module.wasm"), dune);
writeFileSync(
  join(root, "src/modules/org.cgp.dune-growth/bytes.ts"),
  `const DUNE_WASM_BASE64 = ${JSON.stringify(Buffer.from(dune).toString("base64"))};

function decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const duneWasmBytes = decode(DUNE_WASM_BASE64);
`,
);

console.log(`wrote dune ${dune.byteLength} bytes and template ${template.byteLength} bytes`);
