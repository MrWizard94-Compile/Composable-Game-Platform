import { reconcileIdleDeletionClaims } from "../src/packages/local-store.ts";

type Args = { store?: string; apply: boolean; digest?: string };
function parse(args: string[]): Args {
  const result: Args = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--apply") { result.apply = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--store") result.store = value;
    else if (flag === "--digest") result.digest = value;
    else throw new Error("Unknown argument: " + flag);
  }
  if (!result.store || !result.apply) {
    throw new Error("Usage: npm run store:gc-reconcile -- --store <store-dir> --apply [--digest sha256:<hex>]. This releases idle claims only and does not delete package bytes.");
  }
  return result;
}
if (process.argv[1] && process.argv[1].endsWith("reconcile-store-claims.ts")) {
  try {
    const args = parse(process.argv.slice(2));
    const report = await reconcileIdleDeletionClaims(args.store!, { digest: args.digest });
    console.log(JSON.stringify(report, null, 2));
    console.log("\nReleased idle deletion claims. No package bytes were deleted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
