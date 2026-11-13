import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmBackend } from "../src/foundations/wasm-backend.ts";
import { compose } from "../src/foundations/host.ts";
import { validateManifest } from "../src/foundations/manifest.ts";
import { guestFromContributions, type GuestContribution } from "../src/foundations/wasm-build.ts";

export type WasmPackageCheck =
  | {
      ok: true;
      moduleId: string;
      contributions: Array<{ slotId: string; id: string; moduleId: string }>;
    }
  | { ok: false; errors: string[] };

function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * Load a portable package the way an author outside this repository would.
 * `guest.json`, when present, must compile to the shipped `module.wasm`.
 * A package with its own toolchain omits `guest.json` and is still instantiated.
 */
export async function checkWasmPackage(dir: string): Promise<WasmPackageCheck> {
  const errors: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  const wasmPath = join(dir, "module.wasm");
  if (!existsSync(manifestPath)) errors.push("manifest.json is missing.");
  if (!existsSync(wasmPath)) errors.push("module.wasm is missing.");
  if (existsSync(join(dir, "module.ts"))) errors.push("A portable package has module.wasm and no module.ts.");
  if (errors.length > 0) return { ok: false, errors };
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    return { ok: false, errors: ["manifest.json is not JSON."] };
  }
  const validated = validateManifest(manifest);
  if (!validated.ok) return { ok: false, errors: validated.errors.map((item) => item.message) };
  const bytes = new Uint8Array(readFileSync(wasmPath));
  const guestPath = join(dir, "guest.json");
  if (existsSync(guestPath)) {
    let spec: { contributions?: GuestContribution[] };
    try {
      spec = JSON.parse(readFileSync(guestPath, "utf8")) as { contributions?: GuestContribution[] };
    } catch {
      return { ok: false, errors: ["guest.json is not JSON."] };
    }
    if (!Array.isArray(spec.contributions)) return { ok: false, errors: ["guest.json must contain a contributions array."] };
    if (!same(bytes, guestFromContributions(spec.contributions))) {
      return { ok: false, errors: ["module.wasm does not match guest.json. Run scripts/build-wasm-module.ts on this folder."] };
    }
  }
  const backend = createWasmBackend();
  const result = await compose([{ manifest: validated.manifest, implementation: { wasm: bytes } }], {
    backend,
    policy: { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536 },
  });
  if (!result.runtimeActive) {
    await backend.dispose();
    return { ok: false, errors: result.diagnostics.map((item) => item.message) };
  }
  const contributions = result.contributions.map((item) => ({ slotId: item.slotId, id: item.id, moduleId: item.moduleId }));
  await result.shutdown();
  await backend.dispose();
  return { ok: true, moduleId: validated.manifest.moduleId, contributions };
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node --experimental-strip-types scripts/check-wasm-module.ts <package-dir>");
    process.exit(1);
  }
  const report = await checkWasmPackage(target);
  if (!report.ok) {
    console.error(report.errors.join("\n"));
    process.exit(1);
  }
  console.log(`${report.moduleId} ok  ${report.contributions.map((item) => `${item.slotId}:${item.id}`).join(", ")}`);
}
