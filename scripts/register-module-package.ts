import { fileURLToPath } from "node:url";
import { registerStagedPackage } from "../src/packages/local-store.ts";

function parse(args: string[]): { staging?: string; store?: string } {
  const result: { staging?: string; store?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--staging") result.staging = value;
    else if (flag === "--store") result.store = value;
    else throw new Error("Unknown argument: " + flag);
    index += 1;
  }
  return result;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parse(process.argv.slice(2));
    if (!args.staging || !args.store) {
      throw new Error("Usage: node --experimental-strip-types scripts/register-module-package.ts --staging <staging-dir> --store <store-dir>");
    }
    const result = await registerStagedPackage(args.staging, args.store);
    console.log((result.idempotent ? "Already registered: " : "Registered: ") +
      result.entry.moduleId + "@" + result.entry.version);
    console.log("Package tree: " + result.entry.packageTreeProfile + " " + result.entry.packageTreeDigest);
    console.log("Artifact: " + result.entry.artifactDigest);
    console.log("Runtime: " + result.entry.runtime);
    console.log("Object: " + result.objectDirectory);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
