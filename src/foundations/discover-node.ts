import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleImplementation, ModulePackage } from "./host.ts";

export type DiscoveredModule = ModulePackage & {
  folder: string;
};

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Filesystem discovery for the headless host. Each child directory with a
 * manifest.json is a package. module.ts may export `implementation`.
 * This is not a sandbox, and it is not used by the browser build.
 */
export async function discoverModules(root: string): Promise<DiscoveredModule[]> {
  const entries = readdirSync(root, { withFileTypes: true });
  const found: DiscoveredModule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    let implementation: ModuleImplementation | undefined;
    const modulePath = join(root, entry.name, "module.ts");
    if (existsSync(modulePath)) {
      const loaded = (await import(pathToFileURL(modulePath).href)) as { implementation?: ModuleImplementation };
      implementation = loaded.implementation;
    }
    found.push({ folder: entry.name, manifest, implementation });
  }
  found.sort((a, b) => compare(a.folder, b.folder));
  return found;
}
