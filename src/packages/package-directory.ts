import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { inspectWasm } from "../foundations/wasm-backend.ts";
import { validateManifest, type ModuleManifest } from "../foundations/manifest.ts";
import {
  PACKAGE_RESOURCE_LIMITS,
  computeArtifactDigest,
  computePackageTreeDigest,
  parseStrictJson,
  validatePackageDescriptor,
  validatePackagePaths,
  type ModulePackageDescriptor,
  type PackageFile,
} from "./package-format.ts";

export type ReleasePackageSummary = {
  moduleId: string;
  version: string;
  descriptor: ModulePackageDescriptor;
  packageTreeProfile: "cgp.package-tree/1";
  packageTreeDigest: string;
  artifactDigest: string;
  files: string[];
};

export type ReleasePackageValidation =
  | { ok: true; package: ReleasePackageSummary; manifest: ModuleManifest }
  | { ok: false; errors: string[] };

type ScanResult = {
  files: PackageFile[];
  errors: string[];
  totalBytes: number;
};

function scanDirectory(root: string, maxTotalBytes?: number): ScanResult {
  const files: PackageFile[] = [];
  const errors: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let resourceLimitExceeded = false;
  const byteLimit = maxTotalBytes === undefined
    ? undefined
    : Math.min(maxTotalBytes, PACKAGE_RESOURCE_LIMITS.maxTotalBytes);
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch {
    return { files, errors: ["Package directory does not exist or cannot be inspected."], totalBytes };
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { files, errors: ["Package root must be a real directory, not a symlink or file."], totalBytes };
  }

  function visit(directory: string, prefix: string): void {
    if (resourceLimitExceeded) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      ));
    } catch {
      errors.push("Cannot read package directory \"" + (prefix || ".") + "\".");
      return;
    }

    for (const entry of entries) {
      if (resourceLimitExceeded) return;
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (byteLimit !== undefined) {
        if (Buffer.byteLength(path, "utf8") > PACKAGE_RESOURCE_LIMITS.maxPathBytes) {
          errors.push("Package path exceeds the " + PACKAGE_RESOURCE_LIMITS.maxPathBytes + "-byte snapshot limit: " + path);
          resourceLimitExceeded = true;
          return;
        }
        if (path.split("/").length > PACKAGE_RESOURCE_LIMITS.maxPathDepth) {
          errors.push("Package path exceeds the " + PACKAGE_RESOURCE_LIMITS.maxPathDepth + "-component snapshot limit: " + path);
          resourceLimitExceeded = true;
          return;
        }
      }
      const absolute = join(directory, entry.name);
      let info;
      try {
        info = lstatSync(absolute);
      } catch {
        errors.push("Cannot inspect package entry \"" + path + "\".");
        continue;
      }
      if (info.isSymbolicLink()) {
        errors.push("Package entry \"" + path + "\" is a symbolic link.");
        continue;
      }
      if (info.isDirectory()) {
        if (entry.name.toLowerCase() === "node_modules") {
          errors.push("Package contains a forbidden node_modules directory at \"" + path + "\".");
          continue;
        }
        visit(absolute, path);
        continue;
      }
      if (!info.isFile()) {
        errors.push("Package entry \"" + path + "\" is not a regular file.");
        continue;
      }
      if (byteLimit !== undefined) {
        if (info.size > PACKAGE_RESOURCE_LIMITS.maxFileBytes) {
          errors.push("Package file exceeds the " + PACKAGE_RESOURCE_LIMITS.maxFileBytes + "-byte snapshot limit: " + path);
          resourceLimitExceeded = true;
          return;
        }
        if (fileCount + 1 > PACKAGE_RESOURCE_LIMITS.maxFiles) {
          errors.push("Package exceeds the " + PACKAGE_RESOURCE_LIMITS.maxFiles + "-file snapshot limit.");
          resourceLimitExceeded = true;
          return;
        }
        if (totalBytes + info.size > byteLimit) {
          errors.push("Package snapshot exceeds the configured byte limit of " + byteLimit + " bytes.");
          resourceLimitExceeded = true;
          return;
        }
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
        const afterRead = lstatSync(absolute);
        if (afterRead.isSymbolicLink() || !afterRead.isFile() ||
            afterRead.dev !== info.dev || afterRead.ino !== info.ino ||
            afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs ||
            bytes.byteLength !== info.size) {
          errors.push("Package file changed while it was being read: " + path);
          continue;
        }
      } catch {
        errors.push("Cannot read package file \"" + path + "\".");
        continue;
      }
      files.push({ path, bytes: new Uint8Array(bytes) });
      fileCount += 1;
      totalBytes += bytes.byteLength;
    }
  }

  visit(resolve(root), "");
  return { files, errors, totalBytes };
}

async function validateJavaScriptEntry(path: string): Promise<string[]> {
  try {
    const result = await build({
      entryPoints: [path],
      absWorkingDir: resolve(path, ".."),
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      metafile: true,
      plugins: [{
        name: "cgp-v1-static-import-policy",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return undefined;
            if (args.kind === "import-statement" && args.path.startsWith("node:") && isBuiltin(args.path)) {
              return { path: args.path, external: true };
            }
            return {
              errors: [{
                text: "CGP format v1 permits only static imports with node: specifiers; refused " +
                  args.kind + " for \"" + args.path + "\".",
              }],
            };
          });
        },
      }],
    });
    const entryOutput = Object.values(result.metafile?.outputs ?? {}).find((item) => item.entryPoint !== undefined);
    if (!entryOutput?.exports.includes("implementation")) {
      return ["module.mjs must provide the named export implementation."];
    }
    return [];
  } catch (error) {
    if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
      return error.errors.map((item: { text?: string }) => item.text ?? "JavaScript entrypoint failed static validation.");
    }
    return [error instanceof Error ? error.message : "JavaScript entrypoint failed static validation."];
  }
}

/**
 * Validates a released package directory without importing JavaScript or instantiating WebAssembly.
 * This is package tooling, deliberately separate from the Foundations composition/runtime path.
 */
type ScannedPackageValidation =
  | {
      ok: true;
      package: ReleasePackageSummary;
      manifest: ModuleManifest;
      artifactBytes: Uint8Array;
      packageBytes: number;
    }
  | { ok: false; errors: string[] };

async function validateScannedPackageDirectory(
  directory: string,
  scanned: ScanResult,
  requiredRuntime?: "wasm-core",
): Promise<ScannedPackageValidation> {
  const errors = [...scanned.errors];
  if (errors.length > 0) return { ok: false, errors };

  const treeCheck = validatePackagePaths(scanned.files.map((item) => item.path));
  errors.push(...treeCheck);
  if (errors.length > 0) return { ok: false, errors };

  const byPath = new Map(scanned.files.map((item) => [item.path, item]));
  const manifestFile = byPath.get("manifest.json");
  const descriptorFile = byPath.get("cgp-package.json");
  if (!manifestFile) errors.push("manifest.json is missing.");
  if (!descriptorFile) errors.push("cgp-package.json is missing.");
  if (!manifestFile || !descriptorFile) return { ok: false, errors };

  const parsedManifest = parseStrictJson(manifestFile.bytes, "manifest.json");
  if (!parsedManifest.ok) errors.push(parsedManifest.error);
  const parsedDescriptor = parseStrictJson(descriptorFile.bytes, "cgp-package.json");
  if (!parsedDescriptor.ok) errors.push(parsedDescriptor.error);
  if (!parsedManifest.ok || !parsedDescriptor.ok) return { ok: false, errors };

  const manifestCheck = validateManifest(parsedManifest.value);
  if (!manifestCheck.ok) errors.push(...manifestCheck.errors.map((item) => item.message));
  const descriptorCheck = validatePackageDescriptor(parsedDescriptor.value);
  if (!descriptorCheck.ok) errors.push(...descriptorCheck.errors);
  if (!manifestCheck.ok || !descriptorCheck.ok) return { ok: false, errors };

  if (requiredRuntime && descriptorCheck.descriptor.runtime.kind !== requiredRuntime) {
    return {
      ok: false,
      errors: [
        "Package runtime is " + descriptorCheck.descriptor.runtime.kind +
        "; this snapshot operation accepts only " + requiredRuntime + ".",
      ],
    };
  }

  const wasmFile = byPath.get("module.wasm");
  const jsFile = byPath.get("module.mjs");
  if (descriptorCheck.descriptor.runtime.kind === "wasm-core") {
    if (!wasmFile) errors.push("module.wasm is missing for the wasm-core package.");
    if (jsFile) errors.push("A wasm-core package must not also contain module.mjs.");
    if (wasmFile) errors.push(...validateWasm(wasmFile.bytes, manifestCheck.manifest.permissions));
  } else {
    if (!jsFile) errors.push("module.mjs is missing for the javascript-esm package.");
    if (wasmFile) errors.push("A javascript-esm package must not also contain module.wasm.");
    if (jsFile) {
      errors.push(...await validateJavaScriptEntry(join(resolve(directory), "module.mjs")));
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const files = scanned.files;
  const packageTreeDigest = computePackageTreeDigest(files);
  const runtimePath = descriptorCheck.descriptor.runtime.entry;
  const artifact = byPath.get(runtimePath);
  if (!artifact) return { ok: false, errors: ["Selected runtime artifact is missing."] };

  return {
    ok: true,
    manifest: manifestCheck.manifest,
    package: {
      moduleId: manifestCheck.manifest.moduleId,
      version: manifestCheck.manifest.version,
      descriptor: descriptorCheck.descriptor,
      packageTreeProfile: "cgp.package-tree/1",
      packageTreeDigest,
      artifactDigest: computeArtifactDigest(artifact.bytes),
      files: [...files].map((item) => item.path).sort(),
    },
    artifactBytes: artifact.bytes,
    packageBytes: scanned.totalBytes,
  };
}

/**
 * Validates a released package directory without importing JavaScript or instantiating WebAssembly.
 * This is package tooling, deliberately separate from the Foundations composition/runtime path.
 */
export async function validateReleasePackageDirectory(directory: string): Promise<ReleasePackageValidation> {
  const checked = await validateScannedPackageDirectory(directory, scanDirectory(directory));
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, package: checked.package, manifest: checked.manifest };
}

export type WasmReleasePackageSnapshot = {
  package: ReleasePackageSummary;
  manifest: ModuleManifest;
  /** Private, owned copy of the exact Wasm bytes included in both checked digests. */
  wasmBytes: Uint8Array;
  /** Total size of every file in the verified package tree, not just the Wasm artifact. */
  packageBytes: number;
};

export type WasmReleasePackageSnapshotValidation =
  | { ok: true; snapshot: WasmReleasePackageSnapshot }
  | { ok: false; errors: string[] };

/**
 * Produces a Wasm-only runtime snapshot from one bounded directory scan.
 * The returned bytes are copied from the same scanned file set used for package-tree
 * and artifact digest verification. This function does not import, instantiate, or execute code.
 */
export async function snapshotWasmReleasePackageDirectory(
  directory: string,
  maxPackageBytes: number,
): Promise<WasmReleasePackageSnapshotValidation> {
  if (!Number.isSafeInteger(maxPackageBytes) || maxPackageBytes <= 0) {
    return { ok: false, errors: ["maxPackageBytes must be a positive safe integer."] };
  }
  const scanned = scanDirectory(directory, maxPackageBytes);
  const checked = await validateScannedPackageDirectory(directory, scanned, "wasm-core");
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return {
    ok: true,
    snapshot: {
      package: checked.package,
      manifest: checked.manifest,
      wasmBytes: new Uint8Array(checked.artifactBytes),
      packageBytes: checked.packageBytes,
    },
  };
}
