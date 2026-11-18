import { fileURLToPath } from "node:url";
import { readLocalCatalog, verifyLocalStore } from "../src/packages/local-store.ts";

function parse(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--store") {
    throw new Error("Usage: node --experimental-strip-types scripts/check-module-store.ts --store <store-dir>");
  }
  return args[1]!;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const store = parse(process.argv.slice(2));
    const catalog = readLocalCatalog(store);
    const result = await verifyLocalStore(store);
    console.log("Catalog entries: " + catalog.entries.length);
    console.log("Objects verified: " + result.valid + "/" + result.checked);
    for (const item of result.errors) {
      console.error(item.moduleId + "@" + item.version + ": " + item.error);
    }
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
