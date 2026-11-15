import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { validateManifest } from "../foundations/manifest.ts";
import {
  PACKAGE_RESOURCE_LIMITS,
  computeArtifactDigest,
  computePackageTreeDigest,
  parseStrictJson,
  type PackageFile,
} from "./package-format.ts";
import { validateReleasePackageDirectory } from "./package-directory.ts";

export type ReleaseRuntimeKind = "wasm-core" | "javascript-esm";

export const RELEASE_RESOURCE_LIMITS = PACKAGE_RESOURCE_LIMITS;

export type BuildReleasePackageOptions = {
  sourceDirectory: string;
  releaseDirectory: string;
  stagingDirectory: string;
  runtime?: ReleaseRuntimeKind;
  include?: readonly string[];
  summaryFile?: string;
};

export type ReleaseSummary = {
  schema: "cgp.release-summary/1";
  createdAt: string;
  moduleId: string;
  version: string;
  runtime: ReleaseRuntimeKind;
  packageTreeProfile: "cgp.package-tree/1";
  packageTreeDigest: string;
  artifactDigest: string;
  files: string[];
  releaseDirectory: string;
  stagingDirectory: string;
  summaryFile: string;
  resourceLimits: typeof RELEASE_RESOURCE_LIMITS;
};

export type ReleaseBuildResult = {
  summary: ReleaseSummary;
  summaryPath: string;
};

const DEFAULT_INCLUDE = ["README.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md", "COPYING", "docs", "assets", "data"];
const BUILTIN_NODE_SPECIFIERS = new Set(
  builtinModules.flatMap((item) => [item, item.startsWith("node:") ? item : "node:" + item]),
);

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function assertDisjointDirectories(source: string, release: string, staging: string): void {
  const pairs: Array<[string, string, string]> = [
    [source, release, "source and release"],
    [source, staging, "source and staging"],
    [release, staging, "release and staging"],
  ];
  for (const [a, b, label] of pairs) {
    if (isWithin(a, b) || isWithin(b, a)) {
      throw new Error("The " + label + " directories must not overlap.");
    }
  }
}

function assertPortableRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes(":")) {
    throw new Error("Included paths must be non-empty relative paths using forward slashes: " + path);
  }
  const normalized = path.split("/").join("/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Included path contains an empty, dot, or parent component: " + path);
  }
  return normalized;
}

function checkPathBudget(path: string): void {
  if (Buffer.byteLength(path, "utf8") > RELEASE_RESOURCE_LIMITS.maxPathBytes) {
    throw new Error("Package path exceeds the " + RELEASE_RESOURCE_LIMITS.maxPathBytes + "-byte path limit: " + path);
  }
  if (path.split("/").length > RELEASE_RESOURCE_LIMITS.maxPathDepth) {
    throw new Error("Package path exceeds the " + RELEASE_RESOURCE_LIMITS.maxPathDepth + "-component depth limit: " + path);
  }
}

function chargeFile(path: string, size: number, budget: ResourceBudget): void {
  checkPathBudget(path);
  if (size > RELEASE_RESOURCE_LIMITS.maxFileBytes) {
    throw new Error("Package file exceeds the " + RELEASE_RESOURCE_LIMITS.maxFileBytes + "-byte file limit: " + path);
  }
  if (budget.files + 1 > RELEASE_RESOURCE_LIMITS.maxFiles) {
    throw new Error("Package exceeds the " + RELEASE_RESOURCE_LIMITS.maxFiles + "-file limit.");
  }
  if (budget.totalBytes + size > RELEASE_RESOURCE_LIMITS.maxTotalBytes) {
    throw new Error("Package exceeds the " + RELEASE_RESOURCE_LIMITS.maxTotalBytes + "-byte total content limit.");
  }
  budget.files += 1;
  budget.totalBytes += size;
}

function copyAuthoringEntry(
  sourceRoot: string,
  relativePath: string,
  destinationRoot: string,
  budget: ResourceBudget,
): string[] {
  const path = assertPortableRelativePath(relativePath);
  const sourcePath = join(sourceRoot, ...path.split("/"));
  const destinationPath = join(destinationRoot, ...path.split("/"));
  let info;
  try {
    info = lstatSync(sourcePath);
  } catch {
    return [];
  }
  if (info.isSymbolicLink()) throw new Error("Authoring input must not contain symbolic links: " + path);
  if (info.isDirectory()) {
    const copied: string[] = [];
    for (const entry of readdirSync(sourcePath).sort()) {
      copied.push(...copyAuthoringEntry(sourceRoot, path + "/" + entry, destinationRoot, budget));
    }
    return copied;
  }
  if (!info.isFile()) throw new Error("Authoring input is not a regular file: " + path);

  chargeFile(path, info.size, budget);
  const bytes = readFileSync(sourcePath);
  const afterRead = lstatSync(sourcePath);
  if (afterRead.isSymbolicLink() || !afterRead.isFile() ||
      afterRead.dev !== info.dev || afterRead.ino !== info.ino ||
      afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs) {
    throw new Error("Authoring input changed while it was being copied: " + path);
  }

  const destinationRelative = path;
  const destination = join(destinationRoot, ...destinationRelative.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx" });
  return [destinationRelative];
}

function collectPackageFiles(directory: string): PackageFile[] {
  const files: PackageFile[] = [];
  const budget: ResourceBudget = { files: 0, totalBytes: 0 };
  function visit(current: string, prefix: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      const absolute = join(current, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error("Staging snapshot contains a symbolic link: " + path);
      if (info.isDirectory()) visit(absolute, path);
      else if (info.isFile()) {
        chargeFile(path, info.size, budget);
        files.push({ path, bytes: new Uint8Array(readFileSync(absolute)) });
      }
      else throw new Error("Staging snapshot contains a special filesystem entry: " + path);
    }
  }
  visit(directory, "");
  return files;
}

function removeSnapshot(directory: string): void {
  if (!existsSync(directory)) return;
  function thaw(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) thaw(absolute);
      try { chmodSync(absolute, entry.isDirectory() ? 0o755 : 0o644); } catch {}
    }
    try { chmodSync(current, 0o755); } catch {}
  }
  thaw(directory);
  rmSync(directory, { recursive: true, force: true });
}

function freezeSnapshot(directory: string): void {
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error("Refusing to freeze a snapshot containing a symlink.");
      if (info.isDirectory()) {
        visit(absolute);
        chmodSync(absolute, 0o555);
      } else if (info.isFile()) {
        chmodSync(absolute, 0o444);
      } else {
        throw new Error("Refusing to freeze a snapshot containing a special entry.");
      }
    }
  }
  visit(directory);
  chmodSync(directory, 0o555);
}

async function buildJavaScriptArtifact(source: string, output: string): Promise<void> {
  await build({
    entryPoints: [source],
    outfile: output,
    bundle: true,
    write: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [{
      name: "cgp-release-static-imports",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          if (args.kind === "dynamic-import") {
            return { errors: [{ text: "Dynamic imports are not permitted in a CGP v1 release." }] };
          }
          if (isBuiltin(args.path) || BUILTIN_NODE_SPECIFIERS.has(args.path)) {
            if (args.path.startsWith("node:")) return { path: args.path, external: true };
            return { errors: [{ text: "Node built-ins must use node: specifiers: " + args.path }] };
          }
          return undefined;
        });
      },
    }],
  });
}

function writeDescriptor(directory: string, runtime: ReleaseRuntimeKind): void {
  const descriptor = runtime === "wasm-core"
    ? { formatVersion: 1, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" } }
    : {
        formatVersion: 1,
        runtime: {
          kind: "javascript-esm",
          entry: "module.mjs",
          export: "implementation",
          executionTrust: "trusted-in-process",
        },
      };
  writeFileSync(join(directory, "cgp-package.json"), JSON.stringify(descriptor, null, 2) + "\n", { flag: "wx" });
}

function validateAuthoringManifest(source: string): { moduleId: string; version: string } {
  const manifestPath = join(source, "manifest.json");
  const manifestInfo = lstatSync(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error("manifest.json must be a regular file, not a symbolic link.");
  }
  if (manifestInfo.size > RELEASE_RESOURCE_LIMITS.maxFileBytes) {
    throw new Error("manifest.json exceeds the configured per-file size limit.");
  }
  const parsed = parseStrictJson(new Uint8Array(readFileSync(manifestPath)), "manifest.json");
  if (!parsed.ok) throw new Error(parsed.error);
  const checked = validateManifest(parsed.value);
  if (!checked.ok) throw new Error(checked.errors.map((item) => item.message).join("\n"));
  return { moduleId: checked.manifest.moduleId, version: checked.manifest.version };
}

function validateRuntimeInputs(source: string, runtime?: ReleaseRuntimeKind): ReleaseRuntimeKind {
  const tsPath = join(source, "module.ts");
  const wasmPath = join(source, "module.wasm");
  const hasTs = existsSync(tsPath);
  const hasWasm = existsSync(wasmPath);
  for (const [path, present] of [[tsPath, hasTs], [wasmPath, hasWasm]] as const) {
    if (!present) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Runtime authoring input must be a regular file, not a symbolic link: " + path);
    }
    if (info.size > RELEASE_RESOURCE_LIMITS.maxFileBytes) {
      throw new Error("Runtime authoring input exceeds the configured per-file size limit: " + path);
    }
  }
  if (runtime) {
    if (runtime === "javascript-esm" && !hasTs) throw new Error("javascript-esm requires an authoring module.ts.");
    if (runtime === "wasm-core" && !hasWasm) throw new Error("wasm-core requires a compiled module.wasm.");
    return runtime;
  }
  if (hasTs === hasWasm) {
    throw new Error("Runtime selection is ambiguous. Provide exactly one of module.ts or module.wasm, or pass --runtime.");
  }
  return hasWasm ? "wasm-core" : "javascript-esm";
}

function copySnapshot(files: readonly PackageFile[], destination: string): void {
  for (const file of files) {
    const target = join(destination, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: "wx" });
  }
}

export async function buildReleasePackage(
  options: BuildReleasePackageOptions,
): Promise<ReleaseBuildResult> {
  const source = resolve(options.sourceDirectory);
  const release = resolve(options.releaseDirectory);
  const staging = resolve(options.stagingDirectory);
  assertDisjointDirectories(source, release, staging);

  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) {
    throw new Error("Authoring source must be an existing real directory.");
  }
  if (existsSync(release)) throw new Error("Release directory already exists; refusing to overwrite it: " + release);
  if (existsSync(staging)) throw new Error("Staging snapshot already exists; snapshots are immutable: " + staging);

  const identity = validateAuthoringManifest(source);
  const runtime = validateRuntimeInputs(source, options.runtime);
  const summaryPath = resolve(options.summaryFile ?? staging + ".summary.json");
  if (isWithin(release, summaryPath) || isWithin(summaryPath, release) ||
      isWithin(staging, summaryPath) || isWithin(summaryPath, staging) ||
      isWithin(source, summaryPath) || isWithin(summaryPath, source)) {
    throw new Error("The release summary must be outside the source, release, and staging directories.");
  }
  if (existsSync(summaryPath)) throw new Error("Release summary already exists; refusing to overwrite it.");

  mkdirSync(dirname(release), { recursive: true });
  mkdirSync(dirname(staging), { recursive: true });
  mkdirSync(dirname(summaryPath), { recursive: true });

  // Resolve existing parent-directory symlinks before creating any output.
  const sourceCanonical = realpathSync(source);
  const releaseCanonical = resolve(realpathSync(dirname(release)), basename(release));
  const stagingCanonical = resolve(realpathSync(dirname(staging)), basename(staging));
  const summaryCanonical = resolve(realpathSync(dirname(summaryPath)), basename(summaryPath));
  assertDisjointDirectories(sourceCanonical, releaseCanonical, stagingCanonical);
  if (isWithin(sourceCanonical, summaryCanonical) || isWithin(summaryCanonical, sourceCanonical) ||
      isWithin(releaseCanonical, summaryCanonical) || isWithin(summaryCanonical, releaseCanonical) ||
      isWithin(stagingCanonical, summaryCanonical) || isWithin(summaryCanonical, stagingCanonical)) {
    throw new Error("Resolved release, staging, summary, and source paths must not overlap.");
  }

  const releaseTemp = mkdtempSync(join(dirname(release), ".cgp-release-"));
  const stagingTemp = mkdtempSync(join(dirname(staging), ".cgp-stage-"));
  let releasePublished = false;
  let stagingPublished = false;
  let summaryPublished = false;

  try {
    const manifestBytes = readFileSync(join(source, "manifest.json"));
    const budget: ResourceBudget = { files: 0, totalBytes: 0 };
    chargeFile("manifest.json", manifestBytes.byteLength, budget);
    writeFileSync(join(releaseTemp, "manifest.json"), manifestBytes, { flag: "wx" });

    if (runtime === "wasm-core") {
      const copied = copyAuthoringEntry(source, "module.wasm", releaseTemp, budget);
      if (copied.length !== 1) throw new Error("Could not copy module.wasm.");
    } else {
      await buildJavaScriptArtifact(join(source, "module.ts"), join(releaseTemp, "module.mjs"));
      chargeFile("module.mjs", lstatSync(join(releaseTemp, "module.mjs")).size, budget);
    }

    const requestedInclude = [...new Set([...DEFAULT_INCLUDE, ...(options.include ?? [])])]
      .map(assertPortableRelativePath)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    const include = requestedInclude.filter((item, index) =>
      !requestedInclude.slice(0, index).some((parent) => item.startsWith(parent + "/")));
    for (const item of include) {
      if (item === "manifest.json" || item === "cgp-package.json" ||
          item === "module.ts" || item === "module.mjs" || item === "module.wasm" ||
          item === "package.json" || item === "node_modules") {
        throw new Error("Reserved paths cannot be added with --include: " + item);
      }
      copyAuthoringEntry(source, item, releaseTemp, budget);
    }

    writeDescriptor(releaseTemp, runtime);

    const releaseFiles = collectPackageFiles(releaseTemp);
    const releaseValidation = await validateReleasePackageDirectory(releaseTemp);
    if (!releaseValidation.ok) {
      throw new Error("Release directory validation failed:\n" + releaseValidation.errors.join("\n"));
    }
    if (releaseValidation.package.moduleId !== identity.moduleId ||
        releaseValidation.package.version !== identity.version) {
      throw new Error("Release identity changed during packaging.");
    }

    copySnapshot(releaseFiles, stagingTemp);
    freezeSnapshot(stagingTemp);

    const stagedValidation = await validateReleasePackageDirectory(stagingTemp);
    if (!stagedValidation.ok) {
      throw new Error("Staging snapshot validation failed:\n" + stagedValidation.errors.join("\n"));
    }
    const stagedFiles = collectPackageFiles(stagingTemp);
    const releaseTreeDigest = computePackageTreeDigest(releaseFiles);
    const stagedTreeDigest = computePackageTreeDigest(stagedFiles);
    if (releaseTreeDigest !== stagedTreeDigest ||
        releaseValidation.package.artifactDigest !== stagedValidation.package.artifactDigest) {
      throw new Error("Staging snapshot differs from the validated release directory.");
    }

    const summary: ReleaseSummary = {
      schema: "cgp.release-summary/1",
      createdAt: new Date().toISOString(),
      moduleId: identity.moduleId,
      version: identity.version,
      runtime,
      packageTreeProfile: "cgp.package-tree/1",
      packageTreeDigest: stagedValidation.package.packageTreeDigest,
      artifactDigest: stagedValidation.package.artifactDigest,
      files: [...stagedValidation.package.files],
      releaseDirectory: release,
      stagingDirectory: staging,
      summaryFile: summaryPath,
      resourceLimits: RELEASE_RESOURCE_LIMITS,
    };

    if (existsSync(release) || existsSync(staging) || existsSync(summaryPath)) {
      throw new Error("A release, staging snapshot, or summary path appeared during packaging; refusing to overwrite it.");
    }
    renameSync(releaseTemp, release);
    releasePublished = true;
    renameSync(stagingTemp, staging);
    stagingPublished = true;

    const summaryTemp = summaryPath + ".tmp-" + process.pid;
    writeFileSync(summaryTemp, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
    renameSync(summaryTemp, summaryPath);
    summaryPublished = true;
    return { summary, summaryPath };
  } catch (error) {
    if (summaryPublished) rmSync(summaryPath, { force: true });
    if (stagingPublished) removeSnapshot(staging);
    if (releasePublished) rmSync(release, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(releaseTemp, { recursive: true, force: true });
    rmSync(stagingTemp, { recursive: true, force: true });
  }
}
