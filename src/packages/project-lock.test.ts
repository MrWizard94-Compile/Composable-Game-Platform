import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleasePackage } from "./release-pipeline.ts";
import { registerStagedPackage } from "./local-store.ts";
import {
  createProjectLock,
  resolveProjectLock,
  validateProjectLock,
} from "./project-lock.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function makeWritable(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeWritable(path);
    try { chmodSync(path, entry.isDirectory() ? 0o755 : 0o644); } catch {}
  }
  try { chmodSync(directory, 0o755); } catch {}
}

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-project-lock-test-"));
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function buildStarter(root: string): Promise<string> {
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "manifest.json"),
    readFileSync(join(repositoryRoot, "examples/starter-module/manifest.json")));
  writeFileSync(join(source, "module.ts"),
    readFileSync(join(repositoryRoot, "examples/starter-module/module.ts")));
  const staging = join(root, "stage");
  await buildReleasePackage({
    sourceDirectory: source,
    releaseDirectory: join(root, "release"),
    stagingDirectory: staging,
  });
  return staging;
}

function profile() {
  return {
    profileId: "org.example.desk",
    name: "Desk",
    modules: [{ moduleId: "org.example.starter", version: "1.0.0" }],
  };
}

test("creates a deterministic lock and resolves only its exact verified package", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root);
  const store = join(root, "store");
  const registered = await registerStagedPackage(staging, store);
  const project = profile();

  const first = await createProjectLock(store, project);
  const second = await createProjectLock(store, project);
  assert.deepEqual(second, first);
  assert.equal(first.schema, "cgp.project-lock/1");
  assert.equal(first.profileId, project.profileId);
  assert.equal(first.modules.length, 1);
  assert.equal(first.modules[0]!.moduleId, "org.example.starter");
  assert.equal(first.modules[0]!.version, "1.0.0");
  assert.equal(first.modules[0]!.packageTreeDigest, registered.entry.packageTreeDigest);
  assert.equal(first.modules[0]!.artifactDigest, registered.entry.artifactDigest);
  assert.equal(validateProjectLock(first).ok, true);

  const resolved = await resolveProjectLock(store, project, first);
  assert.equal(resolved.modules.length, 1);
  assert.equal(resolved.modules[0]!.objectDirectory, registered.objectDirectory);
  assert.equal(resolved.modules[0]!.entry.packageTreeDigest, first.modules[0]!.packageTreeDigest);

  // Presentation-only edits do not alter the locked dependency identity.
  const renamed = { ...project, name: "Renamed desk", description: "Presentation metadata" };
  assert.equal((await resolveProjectLock(store, renamed, first)).modules.length, 1);
});

test("refuses profile drift, lock tampering, and unknown lock fields", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root);
  const store = join(root, "store");
  await registerStagedPackage(staging, store);
  const project = profile();
  const lock = await createProjectLock(store, project);

  const changedProfile = {
    ...project,
    modules: [{ moduleId: "org.example.starter", version: "1.0.1" }],
  };
  await assert.rejects(
    resolveProjectLock(store, changedProfile, lock),
    /does not match the profile identity/,
  );

  const tampered = {
    ...lock,
    modules: [{
      ...lock.modules[0]!,
      artifactDigest: "sha256:" + "0".repeat(64),
    }],
  };
  await assert.rejects(
    resolveProjectLock(store, project, tampered),
    /Local catalog identity differs from the lockfile/,
  );

  const unknown = { ...lock, mutable: true };
  const validation = validateProjectLock(unknown);
  assert.equal(validation.ok, false);
});

test("refuses an exact project release that is not present in the local store", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  mkdirSync(store);
  await assert.rejects(
    createProjectLock(store, profile()),
    /exact release is not registered/,
  );
});
