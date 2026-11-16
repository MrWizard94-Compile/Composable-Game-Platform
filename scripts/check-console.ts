import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildReleasePackage } from "../src/packages/release-pipeline.ts";
import { buildConsole } from "./build-console.ts";
import { createConsoleServer } from "./serve-console.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const temporaryRoot = mkdtempSync(join(tmpdir(), "cgp-console-integration-"));
const storeDirectory = join(temporaryRoot, "store");
const stagingDirectory = join(temporaryRoot, "staging");
const projectPath = join(temporaryRoot, "project.json");
const lockPath = join(temporaryRoot, "project.cgp.lock.json");
let server: ReturnType<typeof createConsoleServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await buildConsole();

  // Use real release packer output for both supported package runtimes.
  await buildReleasePackage({
    sourceDirectory: join(repositoryRoot, "examples/third-party-module"),
    releaseDirectory: join(temporaryRoot, "releases/beacon-1.0.0"),
    stagingDirectory: join(stagingDirectory, "beacon-1.0.0"),
  });
  await buildReleasePackage({
    sourceDirectory: join(repositoryRoot, "examples/starter-module"),
    releaseDirectory: join(temporaryRoot, "releases/starter-1.0.0"),
    stagingDirectory: join(stagingDirectory, "starter-1.0.0"),
  });
  writeFileSync(projectPath, JSON.stringify({
    profileId: "org.example.console-project",
    name: "Console Integration Project",
    modules: [
      { moduleId: "org.example.beacon", version: "1.0.0" },
      { moduleId: "org.example.starter", version: "1.0.0" },
    ],
  }, null, 2) + "\n");

  server = createConsoleServer({
    storeDirectory,
    stagingDirectory,
    profilePath: projectPath,
    lockPath,
  });
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Console test server did not bind a TCP port.");

  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("http://127.0.0.1:" + address.port + "/");
  await page.getByRole("heading", { name: "Platform overview" }).waitFor();
  await page.locator("#runtime-state[data-state='active']").waitFor({ timeout: 15000 });
  assert.equal(await page.locator(".brand-lockup img").getAttribute("src"), "/assets/brand/logo-lockup.svg");

  // Existing bundled module browsing/composition still works.
  await page.locator('.nav-button[data-view="modules"]').click();
  await page.getByRole("heading", { name: "Module catalog" }).waitFor();
  await page.locator("#module-search").fill("flora");
  assert.ok(await page.locator("#module-list .module-card").count() > 0);

  await page.locator('.nav-button[data-view="composition"]').click();
  await page.locator("#profile-select").selectOption("simulation");
  await page.getByRole("button", { name: "Compose selected profile" }).click();
  await page.locator("#runtime-state[data-state='active']").waitFor({ timeout: 20000 });
  assert.ok(await page.locator(".data-table tbody tr").count() > 0);
  await page.getByRole("button", { name: "Shutdown composition" }).click();

  // Register real immutable staging snapshots into the Node-side local content store.
  await page.locator('.nav-button[data-view="store"]').click();
  await page.getByRole("heading", { name: "Local package store" }).waitFor();
  await page.locator('[data-action="register-staged"][data-name="beacon-1.0.0"]').waitFor();
  const beaconResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/store/register") && response.request().method() === "POST");
  await page.locator('[data-action="register-staged"][data-name="beacon-1.0.0"]').click();
  const beaconResponse = await beaconResponsePromise;
  assert.equal(beaconResponse.status(), 200, "Beacon registration API failed: " + await beaconResponse.text());
  await page.getByText("org.example.beacon", { exact: true }).waitFor();
  await page.locator('[data-action="register-staged"][data-name="starter-1.0.0"]').waitFor();
  await page.locator('[data-action="register-staged"][data-name="starter-1.0.0"]').click();
  await page.getByText("org.example.starter", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Verify all objects" }).click();
  await page.getByText("All catalog-referenced package objects passed verification.").waitFor();
  assert.equal(await page.locator(".data-table tbody tr").count(), 2);

  // Generate the lock from exact profile pins, then resolve it against catalog + actual bytes.
  await page.locator('.nav-button[data-view="project"]').click();
  await page.getByRole("heading", { name: "Console Integration Project" }).waitFor();
  const lockResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/project/lock") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate lockfile" }).click();
  const lockResponse = await lockResponsePromise;
  const lockResponseBody = await lockResponse.text();
  assert.equal(lockResponse.status(), 200, "Project lock API failed: " + lockResponseBody);
  assert.equal(existsSync(lockPath), true, "Lock API returned success but did not publish the lockfile: " + lockResponseBody);
  const projectRefresh = await page.evaluate(async () => {
    const response = await fetch("/api/project", { cache: "no-store" });
    return { status: response.status, body: await response.text() };
  });
  assert.equal(projectRefresh.status, 200, "Project refresh failed after lock creation: " + projectRefresh.body);
  await page.getByText("Created lockfile for org.example.console-project (2 packages).").waitFor();

  await page.getByRole("button", { name: "Verify & resolve lock" }).click();
  await page.getByText("Project lock verified. 2 packages resolved by exact identity.").waitFor();
  const resolvedRows = page.locator(".data-table tbody tr");
  assert.equal(await resolvedRows.count(), 2);
  assert.equal(await resolvedRows.filter({ hasText: "Bytes verified" }).count(), 2);

  // Updating is explicit, and still revalidates all selected store objects before replacement.
  await page.getByRole("button", { name: "Update lockfile" }).click();
  await page.getByText("Updated lockfile for org.example.console-project (2 packages).").waitFor();

  assert.deepEqual(errors, []);
  console.log("CGP console browser check passed (bundled composition, local store, project lock, byte verification).");
} finally {
  if (browser) await browser.close();
  if (server?.listening) {
    await new Promise<void>((resolveClose, reject) => server!.close((error) => error ? reject(error) : resolveClose()));
  }
  makeWritable(temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
