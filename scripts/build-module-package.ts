import { fileURLToPath } from "node:url";
import { buildReleasePackage, type ReleaseRuntimeKind } from "../src/packages/release-pipeline.ts";

type Arguments = {
  source?: string;
  release?: string;
  stage?: string;
  runtime?: ReleaseRuntimeKind;
  summary?: string;
  include: string[];
};

function parseArguments(args: string[]): Arguments {
  const result: Arguments = { include: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--source") result.source = value;
    else if (flag === "--release") result.release = value;
    else if (flag === "--stage") result.stage = value;
    else if (flag === "--summary") result.summary = value;
    else if (flag === "--runtime") {
      if (value !== "wasm-core" && value !== "javascript-esm") {
        throw new Error("--runtime must be wasm-core or javascript-esm.");
      }
      result.runtime = value;
    } else if (flag === "--include") result.include.push(value);
    else throw new Error("Unknown argument: " + flag);
    index += 1;
  }
  return result;
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invoked) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (!args.source || !args.release || !args.stage) {
      throw new Error(
        "Usage: node --experimental-strip-types scripts/build-module-package.ts " +
        "--source <authoring-dir> --release <release-dir> --stage <immutable-stage-dir> " +
        "[--runtime wasm-core|javascript-esm] [--include <path>]... [--summary <file>]",
      );
    }

    const result = await buildReleasePackage({
      sourceDirectory: args.source,
      releaseDirectory: args.release,
      stagingDirectory: args.stage,
      runtime: args.runtime,
      include: args.include,
      summaryFile: args.summary,
    });
    const summary = result.summary;
    console.log(summary.moduleId + "@" + summary.version + " staged successfully.");
    console.log("Runtime: " + summary.runtime);
    console.log("Package tree: " + summary.packageTreeProfile + " " + summary.packageTreeDigest);
    console.log("Artifact: " + summary.artifactDigest);
    console.log("Files (" + summary.files.length + "): " + summary.files.join(", "));
    console.log("Release: " + summary.releaseDirectory);
    console.log("Immutable staging snapshot: " + summary.stagingDirectory);
    console.log("Release summary: " + result.summaryPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
