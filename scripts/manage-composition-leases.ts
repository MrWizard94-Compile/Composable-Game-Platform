import {
  listCompositionLeases,
  releaseAbandonedCompositionLease,
  releaseCompositionLease,
} from "../src/packages/local-store.ts";

type Action = "list" | "release" | "release-abandoned";
type Args = { store?: string; action?: Action; lease?: string; token?: string; apply: boolean };

function parse(args: string[]): Args {
  const result: Args = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--apply") { result.apply = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--store") result.store = value;
    else if (flag === "--action") {
      if (value !== "list" && value !== "release" && value !== "release-abandoned") {
        throw new Error("Unknown composition-lease action: " + value);
      }
      result.action = value;
    } else if (flag === "--lease") result.lease = value;
    else if (flag === "--token") result.token = value;
    else throw new Error("Unknown argument: " + flag);
  }
  if (!result.store || !result.action) {
    throw new Error(
      "Usage: npm run store:leases -- --store <store-dir> --action <list|release|release-abandoned> [--lease <id>] [--token <token>] [--apply]. " +
      "list and release do not delete bytes. release-abandoned requires --apply and does not delete bytes.",
    );
  }
  if (result.action === "list" && (result.apply || result.lease || result.token)) {
    throw new Error("list accepts only --store and --action list.");
  }
  if (result.action === "release") {
    if (result.apply) throw new Error("release does not take --apply. It removes one lease and does not delete package bytes.");
    if (!result.lease || !result.token) throw new Error("release requires --lease and --token.");
  }
  if (result.action === "release-abandoned") {
    if (!result.apply) {
      throw new Error("release-abandoned requires --apply. It drops one retention root and does not delete package bytes.");
    }
    if (!result.lease) throw new Error("release-abandoned requires --lease.");
    if (result.token) throw new Error("release-abandoned does not take --token.");
  }
  return result;
}

if (process.argv[1] && process.argv[1].endsWith("manage-composition-leases.ts")) {
  try {
    const args = parse(process.argv.slice(2));
    if (args.action === "list") {
      const leases = await listCompositionLeases(args.store!);
      console.log(JSON.stringify(leases, null, 2));
      console.log("\nListed " + leases.length + " composition lease(s). Tokens and package bytes were not changed.");
    } else if (args.action === "release") {
      const released = await releaseCompositionLease(args.store!, args.lease!, args.token!);
      console.log(JSON.stringify(released, null, 2));
      console.log("\nLease release does not delete package bytes.");
    } else {
      const released = await releaseAbandonedCompositionLease(args.store!, args.lease!);
      console.log(JSON.stringify(released, null, 2));
      console.log("\nAbandoned the composition lease. Package bytes were not deleted.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
