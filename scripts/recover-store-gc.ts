import { recoverInterruptedStoreDeletions } from "../src/packages/local-store.ts";

type Args = { store?: string; apply: boolean };
function parse(args: string[]): Args {
  const result: Args = { apply: false };
  for (const flag of args) {
    if (flag === "--apply") result.apply = true;
    else if (flag === "--store") continue;
    else if (flag.startsWith("--")) throw new Error("Unknown argument: " + flag);
  }
  const storeIndex = args.indexOf("--store");
  const store = storeIndex >= 0 ? args[storeIndex + 1] : undefined;
  if (!store || store.startsWith("--") || !result.apply) {
    throw new Error("Usage: npm run store:gc-recover -- --store <store-dir> --apply. Recovery can finish a tombstone deletion and refuses to run without --apply.");
  }
  return { store, apply: true };
}
if (process.argv[1] && process.argv[1].endsWith("recover-store-gc.ts")) {
  try {
    const args = parse(process.argv.slice(2));
    const report = await recoverInterruptedStoreDeletions(args.store!);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
