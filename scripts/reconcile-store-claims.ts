import { reconcileIdleDeletionClaims } from "../src/packages/local-store.ts";

type Args = { store?: string; apply: boolean; digest?: string; cancelClaim: boolean };
function parse(args: string[]): Args {
  const result: Args = { apply: false, cancelClaim: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--apply") { result.apply = true; continue; }
    if (flag === "--cancel-claim") { result.cancelClaim = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--store") result.store = value;
    else if (flag === "--digest") result.digest = value;
    else throw new Error("Unknown argument: " + flag);
  }
  if (!result.store || !result.apply) {
    throw new Error(
      "Usage: npm run store:gc-reconcile -- --store <store-dir> --apply [--digest sha256:<hex>] [--cancel-claim]. " +
      "Without --cancel-claim this command does not release token-owned claims and does not consult pid or age. " +
      "--cancel-claim requires --digest and revokes that one holder. No mode deletes package bytes.",
    );
  }
  if (result.cancelClaim && !result.digest) {
    throw new Error("--cancel-claim requires --digest. Refusing to sweep every token-owned deletion claim.");
  }
  return result;
}
if (process.argv[1] && process.argv[1].endsWith("reconcile-store-claims.ts")) {
  try {
    const args = parse(process.argv.slice(2));
    const report = await reconcileIdleDeletionClaims(args.store!, {
      digest: args.digest,
      cancelClaim: args.cancelClaim ? args.digest : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    if (args.cancelClaim) {
      console.log("\nAdministratively cancelled one deletion claim. The token holder no longer owns it. No package bytes were deleted.");
    } else {
      console.log("\nToken-owned deletion claims were left in place. This is not stale-owner recovery. No package bytes were deleted.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}