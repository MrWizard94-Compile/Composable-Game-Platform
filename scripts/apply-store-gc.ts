import { applyLocalStoreGarbageCollection } from "../src/packages/local-store.ts";

type Args = { store?: string; apply: boolean; graceHours: number };
function parse(args: string[]): Args {
  const result: Args = { apply: false, graceHours: 24 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--apply") { result.apply = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--store") result.store = value;
    else if (flag === "--grace-hours") result.graceHours = Number(value);
    else throw new Error("Unknown argument: " + flag);
  }
  if (!result.store || !result.apply) {
    throw new Error("Usage: npm run store:gc-apply -- --store <store-dir> --apply [--grace-hours 24]. Refusing to delete without --apply.");
  }
  if (!Number.isFinite(result.graceHours) || result.graceHours < 0 || !Number.isSafeInteger(result.graceHours * 3600000)) {
    throw new Error("--grace-hours must be non-negative and convert to safe integer milliseconds.");
  }
  return result;
}
if (process.argv[1] && process.argv[1].endsWith("apply-store-gc.ts")) {
  try {
    const args = parse(process.argv.slice(2));
    const report = await applyLocalStoreGarbageCollection(args.store!, { gracePeriodMs: args.graceHours * 3600000 });
    console.log(JSON.stringify(report, null, 2));
    console.log("\nDeleted " + report.deleted.length + " package object(s). Catalog release rows were not removed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
