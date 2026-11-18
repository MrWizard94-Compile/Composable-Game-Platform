import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectLock } from "../src/packages/project-lock.ts";
import { parseStrictJson } from "../src/packages/package-format.ts";

type Arguments = { profile?: string; store?: string; lock?: string };

function parse(args: string[]): Arguments {
  const result: Arguments = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--profile") result.profile = value;
    else if (flag === "--store") result.store = value;
    else if (flag === "--lock") result.lock = value;
    else throw new Error("Unknown argument: " + flag);
    index += 1;
  }
  return result;
}

function readJson(path: string): unknown {
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), path);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parse(process.argv.slice(2));
    if (!args.profile || !args.store || !args.lock) {
      throw new Error(
        "Usage: node --experimental-strip-types scripts/check-project-lock.ts " +
        "--profile <profile.json> --lock <cgp.lock.json> --store <store-dir>",
      );
    }
    const result = await resolveProjectLock(
      args.store,
      readJson(args.profile),
      readJson(args.lock),
    );
    console.log("Project lock verified: " + result.lock.profileId);
    console.log("Verified packages: " + result.modules.length);
    for (const item of result.modules) {
      console.log(item.entry.moduleId + "@" + item.entry.version +
        " " + item.entry.packageTreeDigest);
      console.log("  " + item.objectDirectory);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
