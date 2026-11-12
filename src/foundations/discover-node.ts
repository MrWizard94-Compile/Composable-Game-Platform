import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleImplementation, ModulePackage } from "./host.ts";

export type DiscoveredModule = ModulePackage & {
  folder: string;
  directory: string;
};

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Reads manifests and, when present, raw WebAssembly bytes.
 * It does not import module.ts and it does not instantiate a guest.
 * Call `loadInProcessImplementations` only when a trusted in-process backend
 * is about to run those functions.
 */
export async function discoverModules(root: string): Promise<DiscoveredModule[]> {
  const entries = readdirSync(root, { withFileTypes: true });
  const found: DiscoveredModule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    const wasmPath = join(directory, "module.wasm");
    const wasm = existsSync(wasmPath) ? new Uint8Array(readFileSync(wasmPath)) : undefined;
    const implementation = wasm ? { wasm } : undefined;
    found.push({ folder: entry.name, directory, manifest, implementation });
  }
  found.sort((a, b) => compare(a.folder, b.folder));
  return found;
}

/** Explicit in-process load. This is not part of discovery. */
export async function loadInProcessImplementations(
  modules: readonly DiscoveredModule[],
): Promise<DiscoveredModule[]> {
  const loaded: DiscoveredModule[] = [];
  for (const item of modules) {
    const modulePath = join(item.directory, "module.ts");
    if (!existsSync(modulePath)) {
      loaded.push(item);
      continue;
    }
    const imported = (await import(pathToFileURL(modulePath).href)) as { implementation?: ModuleImplementation };
    loaded.push({
      ...item,
      implementation: item.implementation?.wasm ? { ...imported.implementation, wasm: item.implementation.wasm } : imported.implementation,
    });
  }
  return loaded;
}