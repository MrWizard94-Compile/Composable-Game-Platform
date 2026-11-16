import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectLock } from "../src/packages/project-lock.ts";
import { parseStrictJson } from "../src/packages/package-format.ts";

type Arguments = { profile?: string; store?: string; output?: string; update: boolean };

function parse(args: string[]): Arguments {
  const result: Arguments = { update: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--update") {
      result.update = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--profile") result.profile = value;
    else if (flag === "--store") result.store = value;
    else if (flag === "--output") result.output = value;
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

function writeLock(path: string, content: string, update: boolean): void {
  const output = resolve(path);
  if (!update) {
    writeFileSync(output, content, { flag: "wx", mode: 0o644 });
    return;
  }
  const temporary = resolve(dirname(output), "." + basename(output) + "." + randomUUID() + ".tmp");
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o644 });
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parse(process.argv.slice(2));
    if (!args.profile || !args.store || !args.output) {
      throw new Error(
        "Usage: node --experimental-strip-types scripts/create-project-lock.ts " +
        "--profile <profile.json> --store <store-dir> --output <cgp.lock.json> [--update]",
      );
    }
    if (resolve(args.profile) === resolve(args.output)) {
      throw new Error("The lockfile output path must not overwrite the project profile.");
    }
    const profile = readJson(args.profile);
    const lock = await createProjectLock(args.store, profile);
    writeLock(args.output, JSON.stringify(lock, null, 2) + "\n", args.update);
    console.log("Wrote project lock: " + resolve(args.output));
    console.log("Profile: " + lock.profileId);
    console.log("Modules locked: " + lock.modules.length);
    for (const entry of lock.modules) {
      console.log(entry.moduleId + "@" + entry.version + " " + entry.packageTreeDigest);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
