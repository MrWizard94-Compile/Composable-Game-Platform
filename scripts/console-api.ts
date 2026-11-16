import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseStrictJson } from "../src/packages/package-format.ts";
import { validateReleasePackageDirectory } from "../src/packages/package-directory.ts";
import { readLocalCatalog, registerStagedPackage, verifyLocalStore } from "../src/packages/local-store.ts";
import { createProjectLock, resolveProjectLock } from "../src/packages/project-lock.ts";
import { validateProfile } from "../src/foundations/profile.ts";

export type ConsoleApiOptions = {
  storeDirectory?: string;
  profilePath?: string;
  lockPath?: string;
  stagingDirectory?: string;
};
type Config = Required<Pick<ConsoleApiOptions, "storeDirectory">> & Omit<ConsoleApiOptions, "storeDirectory">;

const BODY_LIMIT = 16 * 1024;
const FILE_LIMIT = 2 * 1024 * 1024;

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep));
}
function configOf(options: ConsoleApiOptions): Config {
  const path = (value?: string) => value ? resolve(process.cwd(), value) : undefined;
  const storeDirectory = path(options.storeDirectory ?? process.env.CGP_STORE_DIR) ?? resolve(".cgp-store");
  const profilePath = path(options.profilePath ?? process.env.CGP_PROJECT_PROFILE);
  const lockPath = path(options.lockPath ?? process.env.CGP_PROJECT_LOCK);
  const stagingDirectory = path(options.stagingDirectory ?? process.env.CGP_STAGING_DIR);
  if (profilePath && lockPath && profilePath === lockPath) throw new Error("Project profile and lockfile paths must be different.");
  if (profilePath && within(storeDirectory, profilePath)) throw new Error("Project profile must not be stored inside the content store.");
  if (lockPath && within(storeDirectory, lockPath)) throw new Error("Project lockfile must not be stored inside the content store.");
  return { storeDirectory, profilePath, lockPath, stagingDirectory };
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}
function strictFile(path: string): unknown {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Configured JSON path must be a regular file, not a symlink.");
  if (info.size > FILE_LIMIT) throw new Error("Configured project JSON exceeds the 2 MiB limit.");
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), path);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
function projectProfile(config: Config) {
  if (!config.profilePath) throw new Error("Project profile is not configured. Start with --profile <project.json>.");
  const checked = validateProfile(strictFile(config.profilePath));
  if (!checked.ok) throw new Error("Project profile validation failed: " + checked.errors.map((item) => item.message).join("; "));
  return checked.profile;
}
function projectLock(config: Config) {
  if (!config.lockPath) throw new Error("Project lockfile path is not configured. Start with --lock <cgp.lock.json>.");
  return strictFile(config.lockPath);
}
function writeLock(path: string, content: string, mode: "create" | "update"): void {
  const parent = dirname(path);
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("Lockfile parent must be an existing real directory.");
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Existing lockfile path is not a regular file.");
    if (mode === "create") throw new Error("Lockfile already exists. Use Update lockfile to replace it.");
  } else if (mode === "update") throw new Error("Cannot update a lockfile that does not exist; create it first.");

  const temporary = join(parent, "." + basename(path) + "." + randomUUID() + ".tmp");
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    if (mode === "create") {
      linkSync(temporary, path); // atomic create; fails if another writer won the race
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path); // same-directory atomic replacement
    }
    try {
      const dir = openSync(parent, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* Some filesystems do not support directory fsync. */ }
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > BODY_LIMIT) throw new Error("Request JSON exceeds 16 KiB.");
    chunks.push(bytes);
  }
  const parsed = parseStrictJson(new Uint8Array(Buffer.concat(chunks)), "API request");
  if (!parsed.ok) throw new Error(parsed.error);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new Error("Request body must be a JSON object.");
  return parsed.value as Record<string, unknown>;
}
function requireLocalSameOrigin(request: IncomingMessage): void {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host || !origin) throw new Error("Mutating API calls require a same-origin browser request.");
  const hostname = host.replace(/:\\d+$/, "").replace(/^\\[(.*)\\]$/, "$1").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) throw new Error("API only accepts loopback requests.");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("Invalid request origin."); }
  if (parsed.protocol !== "http:" || parsed.host.toLowerCase() !== host.toLowerCase()) throw new Error("Cross-origin API request refused.");
}
async function stagingEntries(config: Config) {
  if (!config.stagingDirectory) return [];
  const info = lstatSync(config.stagingDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Staging root must be a real directory.");
  const results = [];
  for (const name of readdirSync(config.stagingDirectory).sort()) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) continue;
    const path = join(config.stagingDirectory, name);
    const item = lstatSync(path);
    if (item.isSymbolicLink() || !item.isDirectory()) continue;
    const checked = await validateReleasePackageDirectory(path);
    results.push(checked.ok ? {
      name, valid: true, moduleId: checked.package.moduleId, version: checked.package.version,
      runtime: checked.package.descriptor.runtime.kind, packageTreeDigest: checked.package.packageTreeDigest,
      artifactDigest: checked.package.artifactDigest, files: checked.package.files,
    } : { name, valid: false, errors: checked.errors });
  }
  return results;
}

export function createConsoleApiHandler(options: ConsoleApiOptions = {}) {
  const config = configOf(options);
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    try {
      const method = request.method ?? "GET";
      if (method === "GET" && pathname === "/api/status") {
        let storeExists = false;
        try { const info = lstatSync(config.storeDirectory); storeExists = info.isDirectory() && !info.isSymbolicLink(); } catch {}
        json(response, 200, {
          ok: true, storeDirectory: config.storeDirectory, storeExists,
          profileConfigured: !!config.profilePath, profilePath: config.profilePath ?? null,
          lockConfigured: !!config.lockPath, lockPath: config.lockPath ?? null,
          lockExists: !!config.lockPath && existsSync(config.lockPath),
          stagingConfigured: !!config.stagingDirectory, stagingDirectory: config.stagingDirectory ?? null,
        });
        return;
      }
      if (method === "GET" && pathname === "/api/store/catalog") {
        const catalog = readLocalCatalog(config.storeDirectory);
        json(response, 200, { ok: true, schema: catalog.schema, entries: catalog.entries, verification: "not-checked" });
        return;
      }
      if (method === "GET" && pathname === "/api/store/verify") {
        const report = await verifyLocalStore(config.storeDirectory);
        json(response, 200, { ok: true, integrityOk: report.errors.length === 0, ...report });
        return;
      }
      if (method === "GET" && pathname === "/api/store/staging") {
        json(response, 200, { ok: true, configured: !!config.stagingDirectory, packages: await stagingEntries(config) });
        return;
      }
      if (method === "GET" && pathname === "/api/project") {
        const profile = projectProfile(config);
        const lockExists = !!config.lockPath && existsSync(config.lockPath);
        let lockPreview: unknown = null;
        let lockError: string | null = null;
        if (lockExists && config.lockPath) {
          try { lockPreview = strictFile(config.lockPath); }
          catch (error) { lockError = error instanceof Error ? error.message : String(error); }
        }
        json(response, 200, {
          ok: true, profile, profilePath: config.profilePath, lockPath: config.lockPath ?? null,
          lockExists, lockPreview, lockError,
        });
        return;
      }
      if (method === "GET" && pathname === "/api/project/resolve") {
        const result = await resolveProjectLock(config.storeDirectory, projectProfile(config), projectLock(config));
        json(response, 200, {
          ok: true, profileId: result.lock.profileId,
          modules: result.modules.map((item) => ({ ...item.entry, verified: true })),
        });
        return;
      }
      if (method === "POST") {
        requireLocalSameOrigin(request);
        const body = await requestBody(request);
        if (pathname === "/api/project/lock") {
          if (body.mode !== "create" && body.mode !== "update") throw new Error("Lockfile mode must be create or update.");
          if (!config.lockPath) throw new Error("Project lockfile path is not configured. Start with --lock <cgp.lock.json>.");
          const lock = await createProjectLock(config.storeDirectory, projectProfile(config));
          writeLock(config.lockPath, JSON.stringify(lock, null, 2) + "\\n", body.mode);
          json(response, 200, { ok: true, mode: body.mode, profileId: lock.profileId, moduleCount: lock.modules.length, modules: lock.modules });
          return;
        }
        if (pathname === "/api/store/register") {
          if (!config.stagingDirectory) throw new Error("Staging root is not configured. Start with --staging <staging-root>.");
          if (typeof body.name !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(body.name)) throw new Error("Valid staging directory name required.");
          const rootInfo = lstatSync(config.stagingDirectory);
          if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Staging root must be a real directory.");
          const stagedPath = join(config.stagingDirectory, body.name);
          const item = lstatSync(stagedPath);
          if (item.isSymbolicLink() || !item.isDirectory() || dirname(resolve(stagedPath)) !== resolve(config.stagingDirectory)) {
            throw new Error("Package must be a direct child directory of the configured staging root.");
          }
          const result = await registerStagedPackage(stagedPath, config.storeDirectory);
          json(response, 200, { ok: true, idempotent: result.idempotent, entry: result.entry });
          return;
        }
      }
      json(response, pathname.startsWith("/api/") ? 404 : 405, { ok: false, error: "Unknown API endpoint or method." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("Cross-origin") || message.includes("same-origin") || message.includes("loopback") ? 403 :
        message.includes("already exists") ? 409 : message.includes("not configured") ? 409 : 400;
      json(response, status, { ok: false, error: message });
    }
  };
}
