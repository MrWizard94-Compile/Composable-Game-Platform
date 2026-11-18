import { compose, type CompositionResult } from "../../src/foundations/host.ts";
import { CROSS_POLICY, createCrossBackend } from "../../src/foundations/cross-backend.ts";
import { resolveProfile, validateProfile } from "../../src/foundations/profile.ts";
import { createBrowserWasmBackend } from "../../src/foundations/wasm-browser.ts";
import { CATALOG, moduleIdOf, toPackage, type CatalogEntry } from "../../src/modules/registry.ts";
import { PROFILES } from "../../src/modules/profiles.ts";

type View = "overview" | "profiles" | "modules" | "composition" | "catalog" | "store" | "project" | "diagnostics" | "settings";
type ModuleFilter = "all" | "baseline" | "javascript" | "wasm" | "manifest-only";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("CGP console root element #app was not found.");

let activeView: View = "overview";
let selectedProfileId = new URLSearchParams(location.search).get("profile") ?? "proof";
let activeComposition: CompositionResult | undefined;
let compositionNotes: string[] = [];
let busy = false;
let moduleSearch = "";
let moduleFilter: ModuleFilter = "all";
type StoreEntry = { moduleId: string; version: string; runtime: string; packageTreeDigest: string; artifactDigest: string; files: string[] };
type StagedEntry = { name: string; valid: boolean; moduleId?: string; version?: string; runtime?: string; packageTreeDigest?: string; errors?: string[] };
type ProjectInfo = {
  profile: { profileId: string; name: string; description?: string; modules: Array<{ moduleId: string; version: string }> };
  profilePath: string;
  lockPath: string | null;
  lockExists: boolean;
  lockPreview: unknown;
  lockError: string | null;
};
let apiStatus: { storeDirectory: string; storeExists: boolean; profileConfigured: boolean; lockConfigured: boolean; stagingConfigured: boolean } | undefined;
let storeEntries: StoreEntry[] = [];
let storeVerification: { checked: number; valid: number; errors: Array<{ moduleId: string; version: string; error: string }> } | undefined;
let stagedEntries: StagedEntry[] = [];
let projectInfo: ProjectInfo | undefined;
let projectResolution: { profileId: string; modules: Array<StoreEntry & { verified: boolean }> } | undefined;
let apiNotice = "";
let projectError = "";
let storeError = "";
let apiBusy = false;

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: { ...(init?.headers ?? {}), ...(init?.method === "POST" ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error ?? ("Console API returned " + response.status));
  return body;
}
async function refreshStoreData(): Promise<void> {
  try {
    const [status, catalog, staging] = await Promise.all([
      apiRequest<typeof apiStatus & { ok: boolean }>("/api/status"),
      apiRequest<{ ok: boolean; entries: StoreEntry[] }>("/api/store/catalog"),
      apiRequest<{ ok: boolean; packages: StagedEntry[] }>("/api/store/staging"),
    ]);
    apiStatus = status!;
    storeEntries = catalog.entries;
    stagedEntries = staging.packages;
    storeError = "";
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error);
  }
  render();
}
async function refreshProjectData(): Promise<void> {
  try {
    projectInfo = await apiRequest<ProjectInfo & { ok: boolean }>("/api/project");
    projectError = "";
  } catch (error) {
    projectInfo = undefined;
    projectError = error instanceof Error ? error.message : String(error);
    if (!projectError.includes("not configured")) apiNotice = projectError;
  }
  render();
}
async function verifyStore(): Promise<void> {
  apiBusy = true; apiNotice = "Verifying every catalog-referenced package object…"; render();
  try {
    storeVerification = await apiRequest<typeof storeVerification & { ok: boolean }>("/api/store/verify");
    apiNotice = storeVerification && storeVerification.errors.length
      ? "Store verification found " + storeVerification.errors.length + " invalid object(s)."
      : "All catalog-referenced package objects passed verification.";
  } catch (error) { apiNotice = error instanceof Error ? error.message : String(error); }
  apiBusy = false;
  await refreshStoreData();
}
async function registerStaged(name: string): Promise<void> {
  apiBusy = true; apiNotice = "Registering " + name + "…"; render();
  try {
    const result = await apiRequest<{ ok: boolean; idempotent: boolean; entry: StoreEntry }>("/api/store/register", {
      method: "POST", body: JSON.stringify({ name }),
    });
    apiNotice = (result.idempotent ? "Already registered: " : "Registered: ") + result.entry.moduleId + "@" + result.entry.version;
  } catch (error) { apiNotice = error instanceof Error ? error.message : String(error); }
  apiBusy = false;
  await refreshStoreData();
}
async function lockAction(mode: "create" | "update"): Promise<void> {
  apiBusy = true; apiNotice = mode === "create" ? "Creating lockfile from verified store packages…" : "Updating lockfile from verified store packages…"; render();
  try {
    const result = await apiRequest<{ ok: boolean; profileId: string; moduleCount: number }>("/api/project/lock", {
      method: "POST", body: JSON.stringify({ mode }),
    });
    apiNotice = (mode === "create" ? "Created" : "Updated") + " lockfile for " + result.profileId + " (" + result.moduleCount + " packages).";
    projectResolution = undefined;
  } catch (error) { apiNotice = error instanceof Error ? error.message : String(error); }
  apiBusy = false;
  await refreshProjectData();
}
async function resolveLock(): Promise<void> {
  apiBusy = true; apiNotice = "Verifying project pins against catalog records and stored bytes…"; render();
  try {
    const result = await apiRequest<{ ok: boolean; profileId: string; modules: Array<StoreEntry & { verified: boolean }> }>("/api/project/resolve");
    projectResolution = result;
    apiNotice = "Project lock verified. " + result.modules.length + " packages resolved by exact identity.";
  } catch (error) { projectResolution = undefined; apiNotice = error instanceof Error ? error.message : String(error); }
  apiBusy = false;
  render();
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] ?? c);
}
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function selectedProfile() {
  return PROFILES.find((item) => item.id === selectedProfileId) ?? PROFILES[0]!;
}
function manifest(entry: CatalogEntry): Record<string, unknown> { return obj(entry.manifest); }
function moduleName(entry: CatalogEntry): string {
  return typeof manifest(entry).name === "string" ? String(manifest(entry).name) : moduleIdOf(entry) || "Invalid manifest";
}
function moduleDescription(entry: CatalogEntry): string {
  return typeof manifest(entry).description === "string" ? String(manifest(entry).description) : "No description supplied.";
}
function moduleVersion(entry: CatalogEntry): string {
  return typeof manifest(entry).version === "string" ? String(manifest(entry).version) : "Unknown";
}
function runtimeOf(entry: CatalogEntry): string {
  if (entry.implementation?.wasm instanceof Uint8Array) return "WebAssembly";
  return entry.implementation ? "JavaScript" : "Manifest only";
}
function statusOf(result: CompositionResult | undefined): string {
  if (!result) return busy ? "Preparing" : "Not loaded";
  if (result.quiesced) return "Shutdown";
  if (result.runtimeActive && result.ok) return "Active";
  if (result.runtimeActive) return "Partially active";
  return "Refused";
}
function statusClass(status: string): string {
  if (status === "Active") return "cgp-badge--success";
  if (status === "Refused") return "cgp-badge--error";
  if (status === "Partially active") return "cgp-badge--warning";
  return "cgp-badge--info";
}
function icon(name: string): string {
  return '<span class="icon icon--' + esc(name) + '" aria-hidden="true"></span>';
}

const NAV: Array<{ id: View; label: string; icon: string; section: "workspace" | "system" }> = [
  { id: "overview", label: "Overview", icon: "home", section: "workspace" },
  { id: "profiles", label: "Profiles", icon: "profiles", section: "workspace" },
  { id: "modules", label: "Modules", icon: "modules", section: "workspace" },
  { id: "composition", label: "Composition", icon: "composition", section: "workspace" },
  { id: "catalog", label: "Bundled", icon: "catalog", section: "workspace" },
  { id: "store", label: "Package Store", icon: "settings", section: "workspace" },
  { id: "project", label: "Project", icon: "profiles", section: "workspace" },
  { id: "diagnostics", label: "Diagnostics", icon: "diagnostics", section: "system" },
  { id: "settings", label: "Settings", icon: "settings", section: "system" },
];
const VIEW_COPY: Record<View, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "Workspace", title: "Platform overview", description: "A live view of the bundled examples, composition state, and host diagnostics." },
  profiles: { eyebrow: "Workspace", title: "Composition profiles", description: "Choose an exact set of module versions. Profiles do not upgrade or select versions automatically." },
  modules: { eyebrow: "Workspace", title: "Module catalog", description: "Browse the module examples bundled with this CGP checkout." },
  composition: { eyebrow: "Workspace", title: "Composition", description: "Resolve a profile through Foundations and inspect its modules, slots, dependencies, and runtime state." },
  catalog: { eyebrow: "Workspace", title: "Bundled catalog", description: "Inspect the example modules compiled into this console build." },
  store: { eyebrow: "Workspace", title: "Local package store", description: "Inspect registered immutable releases, verify stored bytes, and register validated staging snapshots." },
  project: { eyebrow: "Workspace", title: "Project and lockfile", description: "Pin exact releases for a project, generate a reproducible lockfile, and verify that every locked package still matches the local store." },
  diagnostics: { eyebrow: "System", title: "Diagnostics", description: "Review the latest composition report and the phase-by-phase host result." },
  settings: { eyebrow: "System", title: "Console settings", description: "Visual tokens and runtime boundaries for this local browser console." },
};

function renderShell(): void {
  const copy = VIEW_COPY[activeView];
  const nav = (section: "workspace" | "system") => NAV.filter((item) => item.section === section).map((item) =>
    '<button class="nav-button" type="button" data-view="' + item.id + '" aria-current="' + (activeView === item.id ? "page" : "false") + '">' +
    icon(item.icon) + '<span>' + item.label + '</span></button>').join("");
  const state = statusOf(activeComposition);
  app!.innerHTML =
    '<header class="topbar">' +
      '<a class="brand-lockup" href="/" aria-label="CGP overview"><img src="/assets/brand/logo-lockup.svg" alt="CGP — Composable Game Platform"></a>' +
      '<div class="topbar-right"><span class="environment-chip"><span class="environment-dot"></span>Local console</span><span class="version-chip">Foundations API 1.0.0</span></div>' +
    '</header>' +
    '<div class="workspace">' +
      '<aside class="sidebar" aria-label="Main navigation">' +
        '<div><p class="nav-section-label">Workspace</p><nav class="nav-list" aria-label="Workspace">' + nav("workspace") + '</nav></div>' +
        '<div><p class="nav-section-label">System</p><nav class="nav-list" aria-label="System">' + nav("system") + '</nav></div>' +
        '<div class="sidebar-foot"><strong>Composable Game Platform</strong>Modular · Deterministic · Extensible</div>' +
      '</aside>' +
      '<main class="main-content">' +
        '<section class="page-heading"><div><p class="eyebrow">' + copy.eyebrow + '</p><h1>' + copy.title + '</h1><p class="page-subtitle">' + copy.description + '</p></div>' +
          '<div class="heading-actions"><span class="cgp-badge ' + statusClass(state) + '" id="runtime-state" data-state="' + state.toLowerCase().replace(/\s+/g, "-") + '">' + state + '</span>' +
          '<button class="cgp-button cgp-button--primary" type="button" data-action="compose" ' + (busy ? "disabled" : "") + '>' + (busy ? "Composing…" : "Recompose") + '</button></div></section>' +
        '<section id="view-content" aria-live="polite">' + renderView() + '</section>' +
        '<footer class="footer-line"><span>CGP · Local browser console</span><span>Modular · Deterministic · Extensible</span></footer>' +
      '</main>' +
    '</div>';
}

function renderOverview(): string {
  const result = activeComposition;
  const status = statusOf(result);
  const activeModules = result?.modules.filter((item) => item.status === "active").length ?? 0;
  const profile = selectedProfile();
  const flow = result?.order.map((id) => result.modules.find((item) => item.moduleId === id)).filter(Boolean) ?? [];
  let graph = flow.length ? "" : '<div class="empty-graph">No composition order is available. Select a profile and run composition.</div>';
  flow.forEach((item, index) => {
    if (index > 0) graph += '<span class="flow-arrow" aria-hidden="true">→</span>';
    graph += '<div class="flow-node"><span class="flow-node-title">' + esc(item!.name) + '</span><span class="flow-node-id">' +
      esc(item!.moduleId) + '</span><span class="flow-node-state">' + esc(item!.status) + '</span></div>';
  });
  const phases = result?.phases.length ? result.phases.map((phase) =>
    '<div class="phase-row"><span class="phase-name">' + esc(phase.phase) + '</span><span class="phase-detail" title="' +
    esc(phase.detail) + '">' + esc(phase.detail) + '</span><span class="phase-dot phase-dot--' + phase.status +
    '" title="' + phase.status + '" aria-label="' + phase.status + '"></span></div>').join("") :
    '<div class="notice-empty">No composition phases recorded yet.</div>';
  const diagnostics = result?.diagnostics.length ? result.diagnostics.slice(0, 5).map((item) =>
    '<article class="diagnostic-item"><strong>' + esc(item.code) + ' · ' + esc(item.severity) +
    '</strong><p>' + esc(item.message) + '</p></article>').join("") :
    '<div class="notice-empty">No diagnostics reported by the current composition.</div>';

  return '<div class="summary-grid">' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Bundled modules</p><strong class="summary-value">' + CATALOG.length +
    '</strong><p class="summary-detail">Entries in the source catalog</p></article>' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Composition profiles</p><strong class="summary-value">' + PROFILES.length +
    '</strong><p class="summary-detail">Exact-version example selections</p></article>' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Accepted modules</p><strong class="summary-value">' + activeModules +
    '</strong><p class="summary-detail">Admitted by the latest resolution · ' + esc(status) + '</p></article></div>' +
    '<div class="dashboard-grid">' +
      '<article class="cgp-panel"><div class="panel-heading"><div><h2>Composition order</h2><p>Foundations’ resolved module order</p></div><span class="cgp-badge ' +
      statusClass(status) + '">' + esc(status) + '</span></div><div class="panel-body"><div class="composition-flow">' + graph + '</div></div></article>' +
      '<article class="cgp-panel"><div class="panel-heading"><div><h2>Selected profile</h2><p>Exact module pins</p></div></div><div class="panel-body">' +
        '<div class="detail-list"><div class="detail-row"><span class="detail-label">Profile</span><strong class="detail-value">' + esc(profile.profile.name) + '</strong></div>' +
        '<div class="detail-row"><span class="detail-label">Profile ID</span><strong class="detail-value">' + esc(profile.profile.profileId) + '</strong></div>' +
        '<div class="detail-row"><span class="detail-label">Selected modules</span><strong class="detail-value">' + profile.profile.modules.length + '</strong></div>' +
        '<div class="detail-row"><span class="detail-label">Resolved dependencies</span><strong class="detail-value">' + (result?.dependencies.length ?? "—") + '</strong></div>' +
        '<div class="detail-row"><span class="detail-label">Owned slots</span><strong class="detail-value">' + (result?.slots.length ?? "—") + '</strong></div></div>' +
        '<div style="margin-top:15px"><button class="cgp-button cgp-button--secondary" type="button" data-view="composition">Inspect composition</button></div></div></article></div>' +
    '<div class="lower-grid">' +
      '<article class="cgp-panel"><div class="panel-heading"><div><h2>Runtime phases</h2><p>Latest Foundations lifecycle report</p></div></div><div class="panel-body"><div class="phase-list">' + phases + '</div></div></article>' +
      '<article class="cgp-panel"><div class="panel-heading"><div><h2>Diagnostics</h2><p>Latest composition messages</p></div><button class="cgp-button cgp-button--secondary" type="button" data-view="diagnostics">All details</button></div>' +
      '<div class="panel-body"><div class="diagnostic-stack">' + diagnostics + '</div></div></article></div>' +
    '<div class="status-banner">' + icon("warning") + '<div><strong>Execution boundary</strong><p>JavaScript examples run in-process as trusted code. WebAssembly guests use browser workers and the isolate policy. This console is a local development tool, not a security boundary for untrusted JavaScript.</p></div></div>';
}

function moduleMatches(entry: CatalogEntry): boolean {
  const runtime = runtimeOf(entry);
  const query = moduleSearch.trim().toLowerCase();
  const matchesQuery = !query || [moduleIdOf(entry), moduleName(entry), moduleDescription(entry), entry.group].join(" ").toLowerCase().includes(query);
  const matchesFilter = moduleFilter === "all" ||
    (moduleFilter === "baseline" && entry.defaultOn) ||
    (moduleFilter === "javascript" && runtime === "JavaScript") ||
    (moduleFilter === "wasm" && runtime === "WebAssembly") ||
    (moduleFilter === "manifest-only" && runtime === "Manifest only");
  return matchesQuery && matchesFilter;
}
function renderModuleCards(): string {
  const items = CATALOG.filter(moduleMatches);
  if (!items.length) return '<div class="notice-empty">No modules match this filter.</div>';
  return items.map((entry) => '<article class="cgp-panel module-card"><div class="card-topline"><div class="card-identity"><span class="card-icon">' +
    icon("module") + '</span><div><h2 class="card-title">' + esc(moduleName(entry)) + '</h2><p class="card-subtitle">' + esc(moduleIdOf(entry)) +
    '</p></div></div>' + (entry.defaultOn ? '<span class="cgp-badge cgp-badge--info">Baseline</span>' : "") + '</div>' +
    '<p class="card-description">' + esc(moduleDescription(entry)) + '</p><div class="card-meta"><span class="meta-pill">' + esc(entry.group) +
    '</span><span class="meta-pill">v' + esc(moduleVersion(entry)) + '</span><span class="meta-pill">' + esc(runtimeOf(entry)) +
    '</span></div></article>').join("");
}
function renderModules(): string {
  const counts = {
    all: CATALOG.length,
    baseline: CATALOG.filter((item) => item.defaultOn).length,
    javascript: CATALOG.filter((item) => runtimeOf(item) === "JavaScript").length,
    wasm: CATALOG.filter((item) => runtimeOf(item) === "WebAssembly").length,
    "manifest-only": CATALOG.filter((item) => runtimeOf(item) === "Manifest only").length,
  };
  const filters: Array<{ id: ModuleFilter; label: string }> = [
    { id: "all", label: "All" }, { id: "baseline", label: "Baseline" }, { id: "javascript", label: "JavaScript" },
    { id: "wasm", label: "WebAssembly" }, { id: "manifest-only", label: "Manifest only" },
  ];
  return '<div class="catalog-toolbar"><input class="cgp-control search-control" type="search" id="module-search" placeholder="Search module name, ID, or group…" value="' +
    esc(moduleSearch) + '" aria-label="Search modules"><div class="filter-row" role="group" aria-label="Module filters">' +
    filters.map((item) => '<button class="filter-chip" type="button" data-filter="' + item.id + '" aria-pressed="' +
      (moduleFilter === item.id) + '">' + item.label + ' <span>' + counts[item.id] + '</span></button>').join("") +
    '</div></div><div id="module-list" class="module-grid">' + renderModuleCards() + '</div>';
}
function renderProfiles(): string {
  return '<div class="profile-grid">' + PROFILES.map((item) =>
    '<article class="cgp-panel profile-card"><div class="card-topline"><div class="card-identity"><span class="card-icon">' + icon("package") +
    '</span><div><h2 class="card-title">' + esc(item.profile.name) + '</h2><p class="card-subtitle">' + esc(item.profile.profileId) +
    '</p></div></div>' + (item.id === selectedProfileId ? '<span class="cgp-badge cgp-badge--success">Selected</span>' : "") + '</div>' +
    '<p>' + esc(item.profile.description ?? "A bundled exact-version composition example.") + '</p><div class="profile-card-footer">' +
    '<span class="profile-card-count">' + item.profile.modules.length + ' exact module pins</span><button class="cgp-button cgp-button--secondary" type="button" data-action="open-profile" data-profile="' +
    esc(item.id) + '">Open profile</button></div></article>').join("") + '</div>';
}
function renderComposition(): string {
  const result = activeComposition;
  const profile = selectedProfile();
  const options = PROFILES.map((item) => '<option value="' + esc(item.id) + '" ' + (item.id === selectedProfileId ? "selected" : "") + '>' +
    esc(item.profile.name) + ' · ' + esc(item.id) + '</option>').join("");
  const modules = result?.modules.length ? result.modules.map((item) =>
    '<tr><td><span class="table-primary">' + esc(item.name) + '</span><span class="table-secondary">' + esc(item.moduleId) +
    '</span></td><td>' + esc(item.version) + '</td><td><span class="cgp-badge ' + (item.status === "active" ? "cgp-badge--success" : "cgp-badge--error") +
    '">' + esc(item.status) + '</span></td><td>' + esc(item.license ?? "—") + '</td></tr>').join("") :
    '<tr><td colspan="4">No resolved module records.</td></tr>';
  const slots = result?.slots.length ? result.slots.map((slot) =>
    '<tr><td><span class="table-primary">' + esc(slot.slotId) + '</span><span class="table-secondary">Owner: ' + esc(slot.ownerId) +
    '</span></td><td>' + esc(slot.kind) + '</td><td><span class="cgp-badge ' + (slot.status === "ok" ? "cgp-badge--success" : "cgp-badge--warning") +
    '">' + esc(slot.status) + '</span></td><td>' + esc(slot.contributors.join(", ") || "—") + '</td></tr>').join("") :
    '<tr><td colspan="4">No owned slots recorded.</td></tr>';
  const deps = result?.dependencies.length ? result.dependencies.map((item) =>
    '<tr><td>' + esc(item.providerId) + '</td><td>' + esc(item.dependentId) + '</td><td>' + esc(item.kind) + '</td><td>' + esc(item.ref) +
    '</td></tr>').join("") : '<tr><td colspan="4">No dependency edges recorded for this composition.</td></tr>';
  const notes = compositionNotes.length ? '<div class="diagnostic-stack" style="margin-bottom:16px">' +
    compositionNotes.map((item) => '<article class="diagnostic-item"><p>' + esc(item) + '</p></article>').join("") + '</div>' : "";
  return '<div class="composition-toolbar"><label>Profile<select id="profile-select" class="cgp-control" data-control="profile">' + options +
    '</select></label><button class="cgp-button cgp-button--primary" type="button" data-action="compose" ' + (busy ? "disabled" : "") + '>' +
    (busy ? "Composing…" : "Compose selected profile") + '</button><button class="cgp-button cgp-button--secondary" type="button" data-action="shutdown" ' +
    (!result?.runtimeActive || result.quiesced || busy ? "disabled" : "") + '>Shutdown composition</button></div>' + notes +
    '<div class="runtime-summary"><span class="cgp-badge ' + statusClass(statusOf(result)) + '">' + esc(statusOf(result)) + '</span>' +
    '<span class="cgp-badge cgp-badge--info">' + profile.profile.modules.length + ' profile pins</span><span class="runtime-fingerprint" title="' +
    esc(result?.fingerprint ?? "Not composed") + '">Fingerprint: ' + esc(result?.fingerprint ?? "Not composed") + '</span></div>' +
    '<article class="cgp-panel" style="margin-bottom:16px"><div class="panel-heading"><div><h2>Module resolution</h2><p>Module records returned by Foundations</p></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Module</th><th>Version</th><th>State</th><th>License</th></tr></thead><tbody>' + modules +
    '</tbody></table></div></article>' +
    '<article class="cgp-panel" style="margin-bottom:16px"><div class="panel-heading"><div><h2>Owned slots</h2><p>Contracts and actual contribution state</p></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Slot</th><th>Kind</th><th>State</th><th>Contributors</th></tr></thead><tbody>' + slots +
    '</tbody></table></div></article>' +
    '<article class="cgp-panel"><div class="panel-heading"><div><h2>Resolved dependency edges</h2><p>Provider-to-dependent relationships reported by Foundations</p></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Provider</th><th>Dependent</th><th>Kind</th><th>Reference</th></tr></thead><tbody>' + deps +
    '</tbody></table></div></article>';
}
function renderCatalog(): string {
  const groups = Array.from(new Set(CATALOG.map((item) => item.group)));
  return '<div class="summary-grid">' + groups.map((group) => '<article class="cgp-panel summary-card"><p class="summary-label">' + esc(group) +
    '</p><strong class="summary-value">' + CATALOG.filter((item) => item.group === group).length +
    '</strong><p class="summary-detail">Bundled catalog entries</p></article>').join("") + '</div>' +
    '<article class="cgp-panel"><div class="panel-heading"><div><h2>Bundled package inventory</h2><p>Source catalog entries, not local content-store records.</p></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Module</th><th>Group</th><th>Runtime input</th><th>Default proof</th></tr></thead><tbody>' +
    CATALOG.map((entry) => '<tr><td><span class="table-primary">' + esc(moduleName(entry)) + '</span><span class="table-secondary">' +
      esc(moduleIdOf(entry)) + '</span></td><td>' + esc(entry.group) + '</td><td>' + esc(runtimeOf(entry)) +
      '</td><td>' + (entry.defaultOn ? '<span class="cgp-badge cgp-badge--info">Baseline</span>' : "Optional") + '</td></tr>').join("") +
    '</tbody></table></div></article>';
}
function renderDiagnostics(): string {
  const result = activeComposition;
  const diagnostics = result?.diagnostics.length ? result.diagnostics.map((item) =>
    '<article class="diagnostic-item"><strong>' + esc(item.severity.toUpperCase()) + ' · ' + esc(item.code) + ' · ' + esc(item.phase) +
    '</strong><p>' + esc(item.message) + '</p>' + (item.moduleId ? '<span class="table-secondary">Module: ' + esc(item.moduleId) + '</span>' : "") +
    '</article>').join("") : '<div class="notice-empty">No diagnostics have been reported for the latest composition.</div>';
  const phases = result?.phases.length ? result.phases.map((phase) =>
    '<div class="phase-row"><span class="phase-name">' + esc(phase.phase) + '</span><span class="phase-detail" title="' +
    esc(phase.detail) + '">' + esc(phase.detail) + '</span><span class="phase-dot phase-dot--' + phase.status +
    '" aria-label="' + phase.status + '"></span></div>').join("") : '<div class="notice-empty">No phase report is available.</div>';
  return '<div class="dashboard-grid"><article class="cgp-panel"><div class="panel-heading"><div><h2>Diagnostics</h2><p>' +
    (result?.diagnostics.length ?? 0) + ' messages in the latest report</p></div></div><div class="panel-body"><div class="diagnostic-stack">' +
    diagnostics + '</div></div></article><article class="cgp-panel"><div class="panel-heading"><div><h2>Lifecycle phases</h2><p>Latest composition attempt</p></div></div>' +
    '<div class="panel-body"><div class="phase-list">' + phases + '</div></div></article></div>';
}
function renderSettings(): string {
  const tokens = [
    ["Background", "#0B1220"], ["Surface", "#111C2E"], ["Raised surface", "#17263D"], ["Border", "#2A405F"],
    ["Primary text", "#EDF5FF"], ["Muted text", "#A9BCD6"], ["CGP blue", "#20B7F4"], ["CGP cyan", "#55D9FF"],
    ["CGP violet", "#8B72F5"], ["Success", "#2BC77A"], ["Warning", "#F2B84B"], ["Error", "#F16C75"],
  ];
  return '<article class="cgp-panel" style="margin-bottom:16px"><div class="panel-heading"><div><h2>CGP color tokens</h2><p>Palette used by the logo, component stylesheet, and console.</p></div></div>' +
    '<div class="panel-body"><div class="token-grid">' + tokens.map((item) =>
      '<div class="token-item"><span class="token-swatch" style="background:' + item[1] + '"></span><div><div class="token-name">' +
      item[0] + '</div><div class="token-value">' + item[1] + '</div></div></div>').join("") + '</div></div></article>' +
    '<article class="cgp-panel"><div class="panel-heading"><div><h2>Runtime boundaries</h2><p>What this console actually runs</p></div></div><div class="panel-body">' +
    '<div class="detail-list"><div class="detail-row"><span class="detail-label">Host</span><strong class="detail-value">Foundations 1.0.0</strong></div>' +
    '<div class="detail-row"><span class="detail-label">JavaScript modules</span><strong class="detail-value">Trusted in-process</strong></div>' +
    '<div class="detail-row"><span class="detail-label">WebAssembly modules</span><strong class="detail-value">Browser Worker isolate</strong></div>' +
    '<div class="detail-row"><span class="detail-label">Console storage</span><strong class="detail-value">None; no local persistence</strong></div>' +
    '<div class="detail-row"><span class="detail-label">Package acquisition</span><strong class="detail-value">Not implemented here</strong></div></div></div></article>';
}
function renderStore(): string {
  const entries = storeEntries.length ? storeEntries.map((entry) =>
    '<tr><td><span class="table-primary">' + esc(entry.moduleId) + '</span><span class="table-secondary">' + esc(entry.version) + '</span></td>' +
    '<td>' + esc(entry.runtime) + '</td><td><span class="digest-text">' + esc(entry.packageTreeDigest) + '</span><span class="table-secondary">Artifact ' + esc(entry.artifactDigest) + '</span></td>' +
    '<td>' + entry.files.length + '</td></tr>').join("") :
    '<tr><td colspan="4">No packages are registered in this local store yet.</td></tr>';
  const staging = stagedEntries.length ? stagedEntries.map((item) =>
    '<article class="diagnostic-item staged-entry"><div><strong>' + esc(item.name) + '</strong>' +
    (item.valid ? '<p>' + esc(item.moduleId) + '@' + esc(item.version) + ' · ' + esc(item.runtime) + '</p>' :
      '<p>Invalid staging package · ' + esc(item.errors?.join("; ") ?? "Validation failed") + '</p>') +
    '</div>' + (item.valid ? '<button class="cgp-button cgp-button--secondary" type="button" data-action="register-staged" data-name="' + esc(item.name) + '" ' + (apiBusy ? "disabled" : "") + '>Register</button>' : "") +
    '</article>').join("") : '<div class="notice-empty">No validated staging snapshots were found in the configured staging root.</div>';
  const verification = storeVerification
    ? '<span class="cgp-badge ' + (storeVerification.errors.length ? "cgp-badge--error" : "cgp-badge--success") + '">' +
      storeVerification.valid + ' / ' + storeVerification.checked + ' verified</span>'
    : '<span class="cgp-badge cgp-badge--info">Not verified yet</span>';
  return '<div class="summary-grid">' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Registered releases</p><strong class="summary-value">' + storeEntries.length + '</strong><p class="summary-detail">Catalog entries; not a byte-integrity result</p></article>' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Store verification</p><div class="summary-value summary-value--status">' + verification + '</div><p class="summary-detail">Full object verification is explicit</p></article>' +
    '<article class="cgp-panel summary-card"><p class="summary-label">Store location</p><strong class="summary-value summary-value--status">' + esc(apiStatus?.storeDirectory ?? "Unavailable") + '</strong><p class="summary-detail">' + (apiStatus?.storeExists ? "Directory present" : "Created when store API is used") + '</p></article></div>' +
    '<div class="heading-actions store-actions"><button class="cgp-button cgp-button--primary" type="button" data-action="verify-store" ' + (apiBusy ? "disabled" : "") + '>Verify all objects</button><button class="cgp-button cgp-button--secondary" type="button" data-action="refresh-store" ' + (apiBusy ? "disabled" : "") + '>Refresh store</button></div>' +
    (storeError ? '<div class="diagnostic-item api-notice">' + esc(storeError) + '</div>' : "") +
    (apiNotice ? '<div class="diagnostic-item api-notice">' + esc(apiNotice) + '</div>' : "") +
    '<article class="cgp-panel" style="margin-top:16px"><div class="panel-heading"><div><h2>Content-addressed releases</h2><p>Catalog metadata is shown separately from byte verification.</p></div><span class="cgp-badge cgp-badge--info">cgp.local-catalog/1</span></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Release</th><th>Runtime</th><th>Content identity</th><th>Files</th></tr></thead><tbody>' + entries + '</tbody></table></div></article>' +
    '<article class="cgp-panel" style="margin-top:16px"><div class="panel-heading"><div><h2>Staging snapshots</h2><p>Register a validated staged package into the local content store.</p></div></div>' +
    (apiStatus?.stagingConfigured ? '<div class="panel-body"><div class="diagnostic-stack">' + staging + '</div></div>' :
      '<div class="panel-body"><div class="notice-empty">No staging root configured. Restart with --staging &lt;staging-root&gt; to register packages from this screen.</div></div>') +
    '</article>';
}

function renderProject(): string {
  if (!projectInfo) {
    return '<div class="cgp-panel"><div class="panel-heading"><div><h2>Project profile not connected</h2><p>Connect a profile file and lockfile path when starting the local console.</p></div></div>' +
      '<div class="panel-body"><p class="cgp-muted">' + esc(projectError || "No project profile configured.") + '</p><p class="table-secondary">Example: --profile examples/project.json --lock ./out/project.cgp.lock.json</p>' +
      '<button class="cgp-button cgp-button--secondary" type="button" data-action="refresh-project">Retry connection</button></div></div>';
  }
  const pins = projectInfo.profile.modules.map((item) =>
    '<div class="detail-row"><span class="detail-label">' + esc(item.moduleId) + '</span><strong class="detail-value">' + esc(item.version) + '</strong></div>').join("");
  const lockPreview = projectInfo.lockPreview && typeof projectInfo.lockPreview === "object" ? projectInfo.lockPreview as { modules?: unknown[]; profileDigest?: string } : undefined;
  const resolved = projectResolution?.modules.length ? projectResolution.modules.map((item) =>
    '<tr><td><span class="table-primary">' + esc(item.moduleId) + '</span><span class="table-secondary">' + esc(item.version) + '</span></td>' +
    '<td>' + esc(item.runtime) + '</td><td><span class="cgp-badge cgp-badge--success">Bytes verified</span></td>' +
    '<td><span class="digest-text">' + esc(item.packageTreeDigest) + '</span><span class="table-secondary">Artifact ' + esc(item.artifactDigest) + '</span></td></tr>').join("") :
    '<tr><td colspan="4">Lock has not been resolved in this session.</td></tr>';
  const lockState = projectInfo.lockError
    ? '<span class="cgp-badge cgp-badge--error">Unreadable lockfile</span>'
    : projectInfo.lockExists ? '<span class="cgp-badge cgp-badge--info">Lockfile present</span>' : '<span class="cgp-badge cgp-badge--warning">No lockfile yet</span>';
  return '<div class="dashboard-grid">' +
    '<article class="cgp-panel"><div class="panel-heading"><div><h2>' + esc(projectInfo.profile.name) + '</h2><p>' + esc(projectInfo.profile.profileId) + '</p></div>' + lockState + '</div>' +
    '<div class="panel-body"><div class="detail-list"><div class="detail-row"><span class="detail-label">Profile file</span><strong class="detail-value">' + esc(projectInfo.profilePath) + '</strong></div>' +
    '<div class="detail-row"><span class="detail-label">Lockfile</span><strong class="detail-value">' + esc(projectInfo.lockPath ?? "Not configured") + '</strong></div>' +
    '<div class="detail-row"><span class="detail-label">Pinned modules</span><strong class="detail-value">' + projectInfo.profile.modules.length + '</strong></div>' +
    '<div class="detail-row"><span class="detail-label">Lock entries</span><strong class="detail-value">' + (lockPreview?.modules?.length ?? "—") + '</strong></div></div>' +
    '<div class="profile-pin-list">' + pins + '</div></div></article>' +
    '<article class="cgp-panel"><div class="panel-heading"><div><h2>Lockfile actions</h2><p>Exact package identities, verified against stored bytes.</p></div></div><div class="panel-body lock-actions">' +
    '<button class="cgp-button cgp-button--primary" type="button" data-action="' + (projectInfo.lockExists ? "update-lock" : "create-lock") + '" ' + (apiBusy ? "disabled" : "") + '>' + (projectInfo.lockExists ? "Update lockfile" : "Generate lockfile") + '</button>' +
    '<button class="cgp-button cgp-button--secondary" type="button" data-action="resolve-lock" ' + (!projectInfo.lockExists || apiBusy ? "disabled" : "") + '>Verify & resolve lock</button>' +
    (projectInfo.lockError ? '<p class="api-error">' + esc(projectInfo.lockError) + '</p>' : "") +
    '<p class="table-secondary">Updating a lockfile replaces its recorded digests only after all exact releases are found and verified in the store.</p></div></article></div>' +
    (apiNotice ? '<div class="diagnostic-item api-notice">' + esc(apiNotice) + '</div>' : "") +
    '<article class="cgp-panel" style="margin-top:16px"><div class="panel-heading"><div><h2>Verified lock resolution</h2><p>' + (projectResolution ? esc(projectResolution.modules.length + " exact package(s) resolved") : "No verification result for this session") + '</p></div></div>' +
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Package</th><th>Runtime</th><th>Integrity</th><th>Digests</th></tr></thead><tbody>' + resolved + '</tbody></table></div></article>';
}

function renderView(): string {
  switch (activeView) {
    case "overview": return renderOverview();
    case "profiles": return renderProfiles();
    case "modules": return renderModules();
    case "composition": return renderComposition();
    case "catalog": return renderCatalog();
    case "store": return renderStore();
    case "project": return renderProject();
    case "diagnostics": return renderDiagnostics();
    case "settings": return renderSettings();
  }
}
function render(): void { renderShell(); }

async function runComposition(): Promise<void> {
  if (busy) return;
  busy = true;
  compositionNotes = [];
  render();
  try {
    if (activeComposition?.runtimeActive && !activeComposition.quiesced) await activeComposition.shutdown();
    activeComposition = undefined;
    const profile = selectedProfile();
    const checked = validateProfile(profile.profile);
    if (!checked.ok) {
      compositionNotes = checked.errors.map((item) => item.message);
      activeView = "composition";
      return;
    }
    const resolution = resolveProfile(profile.profile, CATALOG.map(toPackage));
    if (!resolution.ok) {
      compositionNotes = resolution.errors.map((item) => item.message);
      activeView = "composition";
      return;
    }
    const backend = createCrossBackend(createBrowserWasmBackend({
      maxHookMs: 1000,
      maxMemoryBytes: 65536,
      maxBinaryBytes: 65536,
    }));
    activeComposition = await compose(resolution.packages, {
      backend,
      policy: CROSS_POLICY,
      profileName: profile.profile.name,
    });
    if (!activeComposition.runtimeActive) compositionNotes = activeComposition.diagnostics.map((item) => item.message);
  } catch (error) {
    compositionNotes = [error instanceof Error ? error.message : String(error)];
  } finally {
    busy = false;
    render();
  }
}

app.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const viewButton = target.closest<HTMLElement>("[data-view]");
  if (viewButton) {
    const view = viewButton.dataset.view as View | undefined;
    if (view && view in VIEW_COPY) {
      activeView = view;
      render();
      if (view === "store") void refreshStoreData();
      if (view === "project") void refreshProjectData();
    }
    return;
  }
  const filterButton = target.closest<HTMLElement>("[data-filter]");
  if (filterButton) {
    moduleFilter = filterButton.dataset.filter as ModuleFilter;
    render();
    return;
  }
  const profileButton = target.closest<HTMLElement>('[data-action="open-profile"]');
  if (profileButton?.dataset.profile) {
    selectedProfileId = profileButton.dataset.profile;
    activeView = "composition";
    render();
    return;
  }
  const actionButton = target.closest<HTMLElement>("[data-action]");
  if (!actionButton) return;
  if (actionButton.dataset.action === "compose") await runComposition();
  if (actionButton.dataset.action === "refresh-store") await refreshStoreData();
  if (actionButton.dataset.action === "verify-store") await verifyStore();
  if (actionButton.dataset.action === "refresh-project") await refreshProjectData();
  if (actionButton.dataset.action === "create-lock") await lockAction("create");
  if (actionButton.dataset.action === "update-lock") await lockAction("update");
  if (actionButton.dataset.action === "resolve-lock") await resolveLock();
  if (actionButton.dataset.action === "register-staged" && actionButton.dataset.name) await registerStaged(actionButton.dataset.name);
  if (actionButton.dataset.action === "shutdown" && activeComposition?.runtimeActive && !activeComposition.quiesced) {
    await activeComposition.shutdown();
    render();
  }
});
app.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.dataset.control === "profile") {
    selectedProfileId = target.value;
    compositionNotes = [];
    render();
  }
});
app.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "module-search") {
    moduleSearch = target.value;
    const list = app!.querySelector<HTMLDivElement>("#module-list");
    if (list) list.innerHTML = renderModuleCards();
  }
});

render();
void runComposition();
void refreshStoreData();
void refreshProjectData();
