import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guestFromContributions, templateGuest, type GuestContribution } from "../src/foundations/wasm-build.ts";
import { duneGrowthGuest } from "../src/modules/org.cgp.dune-growth/guest.ts";
import { boundGuest } from "../src/modules/org.cgp.sim-bound/guest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeBytes(path: string, bytes: Uint8Array) {
  writeFileSync(path, bytes);
  console.log(`wrote ${path} (${bytes.byteLength} bytes)`);
}

/** Compile a folder that has guest.json into module.wasm. Custom code belongs in the author's own toolchain. */
export function compileGuestPackage(dir: string): Uint8Array {
  const spec = JSON.parse(readFileSync(join(dir, "guest.json"), "utf8")) as { contributions?: GuestContribution[] };
  if (!spec || !Array.isArray(spec.contributions)) {
    throw new Error(`${dir} guest.json must contain a contributions array.`);
  }
  const bytes = guestFromContributions(spec.contributions);
  writeBytes(join(dir, "module.wasm"), bytes);
  return bytes;
}

function wasmModule(name: string, bytes: Uint8Array): string {
  const constant = `${name.toUpperCase()}_WASM_BASE64`;
  const exportName = `${name}WasmBytes`;
  return `const ${constant} = ${JSON.stringify(Buffer.from(bytes).toString("base64"))};

function decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const ${exportName} = decode(${constant});
`;
}

function writeBuiltins() {
  const dune = duneGrowthGuest();
  const bound = boundGuest();
  const template = templateGuest();
  writeBytes(join(root, "examples/wasm-module/module.wasm"), template);
  writeBytes(join(root, "src/modules/org.cgp.dune-growth/module.wasm"), dune);
  writeBytes(join(root, "src/modules/org.cgp.sim-bound/module.wasm"), bound);
  writeFileSync(join(root, "src/modules/org.cgp.dune-growth/bytes.ts"), wasmModule("dune", dune));
  writeFileSync(join(root, "src/modules/org.cgp.sim-bound/bytes.ts"), wasmModule("bound", bound));
  console.log(`wrote dune ${dune.byteLength} bytes, boundary ${bound.byteLength} bytes, template ${template.byteLength} bytes`);
}

const packages = process.argv.slice(2);
if (packages.length === 0) {
  writeBuiltins();
  compileGuestPackage(join(root, "examples/third-party-module"));
} else {
  for (const packageDir of packages) compileGuestPackage(packageDir);
}
