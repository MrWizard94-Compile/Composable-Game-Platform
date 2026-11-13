import type { Diagnostic, PhaseRecord } from "./diagnostics.ts";
import { indicted } from "./diagnostics.ts";
import type { ModuleManifest, SlotExposeDecl } from "./manifest.ts";
import { validateManifest } from "./manifest.ts";
import { contractRefMatches, parseContractRef, satisfies } from "./semver.ts";
import { isExclusiveSlot, slotRequiresCallable } from "./slots.ts";
import type { SlotKind } from "./slots.ts";
import type { ExecutionBackend, ExecutionPolicy, ExecutionSession, HostGrant } from "./backend.ts";
export type { ExecutionSession };
import {
  CLOSED_POLICY,
  IN_PROCESS_POLICY,
  deniedSession,
  denyingBackend,
  inProcessBackend,
  policyConflict,
} from "./backend.ts";

/** Foundations API this host implements. Modules declare a range that must admit it. */
export const FOUNDATIONS_API = "1.0.0";

/** Nested slot depth beyond this is refused. Foundations themselves are depth 0. */
export const MAX_SLOT_DEPTH = 8;

/** The only execution mode this host implements. Other values are refused before module code runs. */
export const EXECUTION_TRUST = "trusted-in-process" as const;

export type ExecutionTrust = typeof EXECUTION_TRUST;

const CONTRIBUTION_ID_RE = /^[a-z][a-z0-9-]{0,64}$/;

export const PLATFORM_OWNER = "foundations";

export const PLATFORM_SLOTS: SlotExposeDecl[] = [
  {
    slotId: "platform.systems",
    contract: "platform.system",
    contractVersion: "1.0.0",
    kind: "registry",
    required: false,
    description:
      "Top-level systems. The host stores whatever payload a system registers. It does not interpret it.",
  },
];

export type ContributionInput = {
  id: string;
  order?: number;
  payload: unknown;
};

export type RegisterContext = {
  moduleId: string;
  contribute: (slotId: string, contribution: ContributionInput) => void;
  /** Stores one composition-local value. A second call fails registration. */
  keep: (state: unknown) => void;
};

export type LifecycleContext = {
  moduleId: string;
  /** Contributions already registered into a slot this module owns. */
  ownedSlot: (slotId: string) => readonly ContributionRecord[] | undefined;
  /** The value passed to keep during register, if any. */
  kept: () => unknown;
};

export type ModuleImplementation = {
  /** WebAssembly bytes for an isolating backend. The host does not instantiate them. */
  wasm?: Uint8Array;
  register?: (ctx: RegisterContext) => void;
  initialize?: (ctx: LifecycleContext) => void;
  shutdown?: (ctx: LifecycleContext) => void;
  /** Returns JSON this module owns. Called only by captureSave. */
  exportState?: (ctx: LifecycleContext) => unknown;
  /** Applies a JSON slice from the same save major. Called only by restoreSave. */
  importState?: (ctx: LifecycleContext, saved: unknown) => void;
};

export type ModulePackage = {
  manifest: unknown;
  implementation?: ModuleImplementation;
};

export type ComposeOptions = {
  profileName?: string;
  maxDepth?: number;
  /**
   * `trusted-in-process` opts into the in-process backend and its grants.
   * Any other string is refused. Omit this and pass `backend` to replace the backend.
   */
  trust?: string;
  /** Defaults to the in-process backend, which grants filesystem, network, and os. */
  backend?: ExecutionBackend;
  /**
   * Defaults to a closed policy: no filesystem, network, or OS grant, and no limit
   * the backend cannot enforce. The in-process backend does not satisfy that default.
   */
  policy?: ExecutionPolicy;
};

export type ModuleStatus = "active" | "rejected" | "blocked";

export type ResolvedModule = {
  moduleId: string;
  name: string;
  version: string;
  description?: string;
  status: ModuleStatus;
  manifest?: ModuleManifest;
  provides: ModuleManifest["provides"];
  requires: ModuleManifest["requires"];
  connectsTo: ModuleManifest["connectsTo"];
  exposesSlots: ModuleManifest["exposesSlots"];
  permissions: string[];
  save?: ModuleManifest["save"];
  author?: string;
  license?: string;
};

export type ContributionRecord = {
  slotId: string;
  moduleId: string;
  id: string;
  order: number;
  payload: unknown;
};

export type SlotStatus = "ok" | "conflict" | "ambiguous" | "missing";

export type ResolvedSlot = {
  slotId: string;
  ownerId: string;
  kind: SlotKind;
  contract: string;
  contractVersion: string;
  required: boolean;
  description?: string;
  status: SlotStatus;
  /** Proposed providers, in deterministic order. Empty when the slot itself is in conflict. */
  contributors: string[];
  contestedBy: string[];
};

/** One reason a module is ordered after another. An ambiguous or missing requirement creates no edge. */
export type ResolvedDependency = {
  providerId: string;
  dependentId: string;
  kind: "capability" | "slot";
  ref: string;
};

export type ShutdownReport = {
  already: boolean;
  order: string[];
  diagnostics: Diagnostic[];
};

export type CompositionResult = {
  profileName: string;
  foundationsApi: string;
  /** `trusted-in-process` when that backend was selected. `custom` for a replacement. `unsupported` when the name is unknown. */
  trust: ExecutionTrust | "unsupported" | "custom";
  backendId: string;
  /** Grants the selected backend cannot revoke. Empty when none were selected. */
  grants: readonly HostGrant[];
  /** True only when the selected backend can enforce time and memory limits. */
  limitsEnforced: boolean;
  /** True only when the runtime is active and every selected package was clean. */
  ok: boolean;
  /** True when the admitted graph was registered and initialized. An empty graph counts. */
  runtimeActive: boolean;
  /** Set by shutdown(). Dispatch and save refuse a quiesced runtime. */
  quiesced: boolean;
  phases: PhaseRecord[];
  diagnostics: Diagnostic[];
  modules: ResolvedModule[];
  slots: ResolvedSlot[];
  /** Topological order. Proposed even when the runtime did not start, unless a cycle prevented it. */
  order: string[];
  /** Why that order exists. Present even when the runtime did not start. */
  dependencies: ResolvedDependency[];
  fingerprint: string;
  /** Populated only while the runtime is active. Discarded on rollback. */
  contributions: ContributionRecord[];
  trace: string[];
  shutdown: () => Promise<ShutdownReport>;
};

type Admitted = {
  manifest: ModuleManifest;
  implementation?: ModuleImplementation;
};

type WorkingModule = {
  manifest?: ModuleManifest;
  implementation?: ModuleImplementation;
  status: "pending" | "rejected";
  name: string;
  version: string;
  moduleId: string;
};

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function phase(phaseName: PhaseRecord["phase"], status: PhaseRecord["status"], detail: string): PhaseRecord {
  return { phase: phaseName, status, detail };
}

function fingerprintOf(
  backendId: string,
  order: string[],
  modules: ResolvedModule[],
  slots: ResolvedSlot[],
  dependencies: ResolvedDependency[],
  contributions: ContributionRecord[],
): string {
  const versionOf = new Map(modules.map((item) => [item.moduleId, item.version]));
  const mods = order.map((id) => `${id}@${versionOf.get(id) ?? "unknown"}`).join(">");
  const slotPart = [...slots]
    .sort((a, b) => cmp(a.slotId, b.slotId))
    .map((slot) => {
      const who = (slot.status === "ok" ? slot.contributors : slot.contestedBy).join("+");
      return `${slot.slotId}@${slot.ownerId}:${slot.contract}/${slot.contractVersion}[${slot.status}]=${who}`;
    })
    .join(";");
  const deps = dependencies
    .map((link) => `${link.dependentId}<${link.kind}:${link.ref}<${link.providerId}`)
    .join(";");
  const contribs = [...contributions]
    .sort(contributionSort)
    .map((item) => `${item.slotId}:${item.id}@${item.moduleId}#${item.order}`)
    .join(";");
  return `b:${backendId}|m:${mods}|s:${slotPart}|d:${deps}|c:${contribs}`;
}

function errorDiagnostic(
  code: string,
  message: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    phase: extra.phase ?? "resolve",
    ...extra,
  };
}

function findCycle(nodes: string[], edges: Array<[string, string]>): string[] | null {
  const adjacent = new Map<string, string[]>();
  for (const node of nodes) adjacent.set(node, []);
  for (const [from, to] of edges) adjacent.get(from)?.push(to);

  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adjacent.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, 2);
    return null;
  };

  for (const node of [...nodes].sort(cmp)) {
    if ((color.get(node) ?? 0) === 0) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

function topoSort(nodes: string[], edges: Array<[string, string]>): string[] | null {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node, 0);
    outgoing.set(node, []);
  }
  for (const [from, to] of edges) {
    if (!indegree.has(from) || !indegree.has(to)) continue;
    outgoing.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const ready = nodes.filter((node) => indegree.get(node) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(cmp);
    const next = ready.shift();
    if (!next) break;
    order.push(next);
    for (const child of outgoing.get(next) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order.length === nodes.length ? order : null;
}

function contributionSort(a: ContributionRecord, b: ContributionRecord): number {
  if (a.order !== b.order) return a.order - b.order;
  const byModule = cmp(a.moduleId, b.moduleId);
  if (byModule !== 0) return byModule;
  return cmp(a.id, b.id);
}

async function noopShutdown(): Promise<ShutdownReport> {
  return { already: true, order: [], diagnostics: [] };
}

export async function compose(packages: readonly ModulePackage[], options: ComposeOptions = {}): Promise<CompositionResult> {
  const profileName = options.profileName ?? "unnamed";
  const maxDepth = options.maxDepth ?? MAX_SLOT_DEPTH;
  const diagnostics: Diagnostic[] = [];
  const phases: PhaseRecord[] = [];
  const trace: string[] = [];
  const trustRequest = options.trust;
  const backend = options.backend ?? inProcessBackend;
  const policy =
    options.policy ?? (trustRequest === EXECUTION_TRUST ? IN_PROCESS_POLICY : CLOSED_POLICY);

  if (trustRequest !== undefined && trustRequest !== EXECUTION_TRUST) {
    diagnostics.push(
      errorDiagnostic(
        "trust.unsupported",
        `Execution trust "${trustRequest}" is not implemented. Pass a backend, or "${EXECUTION_TRUST}" to accept the in-process grants.`,
        { phase: "prepare" },
      ),
    );
    phases.push(phase("discover", "skipped", "No packages were opened."));
    phases.push(phase("validate", "skipped", "Skipped because the execution trust is not implemented."));
    phases.push(phase("resolve", "skipped", "Skipped because the execution trust is not implemented."));
    phases.push(phase("prepare", "failed", `Refused trust "${trustRequest}".`));
    phases.push(phase("register", "skipped", "Skipped because the execution trust is not implemented."));
    phases.push(phase("initialize", "skipped", "Skipped because the execution trust is not implemented."));
    phases.push(phase("run", "skipped", "Skipped because the execution trust is not implemented."));
    return assemble({
      profileName,
      trust: "unsupported",
      backendId: "unsupported",
      grants: [],
      limitsEnforced: false,
      runtimeActive: false,
      phases,
      diagnostics,
      working: [],
      slots: [],
      order: [],
      dependencies: [],
      contributions: [],
      trace,
      shutdown: noopShutdown,
      guilty: new Set(),
    });
  }

  const blockedByPolicy = policyConflict(backend, policy);
  if (blockedByPolicy) {
    diagnostics.push(
      errorDiagnostic(blockedByPolicy.code, blockedByPolicy.message, { phase: "prepare" }),
    );
    phases.push(phase("discover", "skipped", "No packages were opened."));
    phases.push(phase("validate", "skipped", "Skipped because the execution policy refused the backend."));
    phases.push(phase("resolve", "skipped", "Skipped because the execution policy refused the backend."));
    phases.push(phase("prepare", "failed", blockedByPolicy.message));
    phases.push(phase("register", "skipped", "Skipped because the execution policy refused the backend."));
    phases.push(phase("initialize", "skipped", "Skipped because the execution policy refused the backend."));
    phases.push(phase("run", "skipped", "Skipped because the execution policy refused the backend."));
    return assemble({
      profileName,
      trust: backend === inProcessBackend ? EXECUTION_TRUST : "custom",
      backendId: backend.id,
      grants: backend.grants,
      limitsEnforced: backend.enforcesLimits,
      backend,
      runtimeActive: false,
      phases,
      diagnostics,
      working: [],
      slots: [],
      order: [],
      dependencies: [],
      contributions: [],
      trace,
      shutdown: noopShutdown,
      guilty: new Set(),
    });
  }

  const trust: ExecutionTrust | "custom" = backend === inProcessBackend ? EXECUTION_TRUST : "custom";
  const backendId = backend.id;
  const grants = backend.grants;
  const limitsEnforced = backend.enforcesLimits;
  backend.configure?.(policy);
  const session = backend.open();
  let retainSession = false;
  try {
  const abandon = async (result: CompositionResult): Promise<CompositionResult> => {
    sessionOfMap.set(result, session);
    await session.release();
    return result;
  };

  phases.push(
    phase("discover", "completed", `Discovered ${packages.length} package${packages.length === 1 ? "" : "s"}.`),
  );

  const seenIds = new Map<string, number>();
  for (const pkg of packages) {
    const id =
      pkg.manifest && typeof pkg.manifest === "object" && "moduleId" in pkg.manifest
        ? String((pkg.manifest as { moduleId?: unknown }).moduleId ?? "")
        : "";
    if (id) seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
  }

  const working: WorkingModule[] = [];

  for (const pkg of packages) {
    const validated = validateManifest(pkg.manifest);
    if (!validated.ok) {
      const hinted = validated.errors.find((item) => item.moduleId)?.moduleId;
      const moduleId = hinted || `invalid:${working.length}`;
      for (const item of validated.errors) {
        diagnostics.push({ ...item, moduleId: item.moduleId ?? (hinted || undefined) });
      }
      working.push({
        status: "rejected",
        moduleId,
        name: "Invalid package",
        version: "0.0.0",
      });
      continue;
    }

    const { manifest } = validated;
    if ((seenIds.get(manifest.moduleId) ?? 0) > 1) {
      diagnostics.push(
        errorDiagnostic(
          "module.duplicate",
          `Module id "${manifest.moduleId}" appears more than once. Both copies were isolated.`,
          { phase: "validate", moduleId: manifest.moduleId },
        ),
      );
      working.push({
        status: "rejected",
        manifest,
        moduleId: manifest.moduleId,
        name: manifest.name,
        version: manifest.version,
        implementation: pkg.implementation,
      });
      continue;
    }

    if (!satisfies(FOUNDATIONS_API, manifest.moduleApi)) {
      diagnostics.push(
        errorDiagnostic(
          "api.incompatible",
          `Module "${manifest.moduleId}" requires Foundations API ${manifest.moduleApi}, but this host is ${FOUNDATIONS_API}.`,
          { phase: "validate", moduleId: manifest.moduleId },
        ),
      );
      working.push({
        status: "rejected",
        manifest,
        moduleId: manifest.moduleId,
        name: manifest.name,
        version: manifest.version,
        implementation: pkg.implementation,
      });
      continue;
    }

    working.push({
      status: "pending",
      manifest,
      implementation: pkg.implementation,
      moduleId: manifest.moduleId,
      name: manifest.name,
      version: manifest.version,
    });
  }

  const isolated = working.filter((item) => item.status === "rejected").length;
  phases.push(
    phase(
      "validate",
      "completed",
      isolated === 0
        ? `Validated ${working.length} package${working.length === 1 ? "" : "s"}.`
        : `Validated packages. Isolated ${isolated} that failed schema, identity, or API checks.`,
    ),
  );

  const admitted: Admitted[] = working
    .filter((item): item is WorkingModule & { manifest: ModuleManifest } => item.status === "pending" && !!item.manifest)
    .map((item) => ({ manifest: item.manifest, implementation: item.implementation }));

  const resolveErrorsAt = diagnostics.length;
  let resolveFailed = false;

  const slotOwner = new Map<string, string>();
  const slotDecl = new Map<string, SlotExposeDecl>();

  for (const slot of PLATFORM_SLOTS) {
    slotOwner.set(slot.slotId, PLATFORM_OWNER);
    slotDecl.set(slot.slotId, slot);
  }

  for (const entry of admitted) {
    for (const slot of entry.manifest.exposesSlots) {
      const existing = slotOwner.get(slot.slotId);
      if (existing) {
        resolveFailed = true;
        const owners = [existing, entry.manifest.moduleId].filter((id) => id !== PLATFORM_OWNER);
        diagnostics.push(
          errorDiagnostic(
            "slot.duplicate-owner",
            `Slot "${slot.slotId}" is already owned by "${existing}". "${entry.manifest.moduleId}" cannot take it.`,
            { slotId: slot.slotId, moduleIds: owners, moduleId: entry.manifest.moduleId },
          ),
        );
        continue;
      }
      slotOwner.set(slot.slotId, entry.manifest.moduleId);
      slotDecl.set(slot.slotId, slot);
    }
  }

  type Connection = { moduleId: string; slotId: string };
  const connections: Connection[] = [];

  for (const entry of admitted) {
    for (const link of entry.manifest.connectsTo) {
      const slot = slotDecl.get(link.slot);
      const owner = slotOwner.get(link.slot);
      if (!slot || !owner) {
        resolveFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "slot.unknown",
            `Module "${entry.manifest.moduleId}" connects to unknown slot "${link.slot}".`,
            { moduleId: entry.manifest.moduleId, slotId: link.slot },
          ),
        );
        continue;
      }
      if (owner === entry.manifest.moduleId) {
        resolveFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "slot.self-connection",
            `Module "${entry.manifest.moduleId}" cannot connect to its own slot "${link.slot}".`,
            { moduleId: entry.manifest.moduleId, slotId: link.slot },
          ),
        );
        continue;
      }
      const ref = parseContractRef(link.contract);
      if (!ref || !contractRefMatches(ref, slot.contract, slot.contractVersion)) {
        resolveFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "slot.contract-mismatch",
            `Module "${entry.manifest.moduleId}" offered contract "${link.contract}" to slot "${link.slot}", which requires ${slot.contract}/${slot.contractVersion}.`,
            { moduleId: entry.manifest.moduleId, slotId: link.slot },
          ),
        );
        continue;
      }
      connections.push({ moduleId: entry.manifest.moduleId, slotId: link.slot });
    }
  }

  const providers = new Map<string, Array<{ moduleId: string; version: string }>>();
  for (const entry of admitted) {
    for (const cap of entry.manifest.provides) {
      const list = providers.get(cap.capability) ?? [];
      list.push({ moduleId: entry.manifest.moduleId, version: cap.version });
      providers.set(cap.capability, list);
    }
  }

  const edges: Array<[string, string]> = [];
  const links: ResolvedDependency[] = [];
  const admittedIds = admitted.map((entry) => entry.manifest.moduleId);

  for (const entry of admitted) {
    for (const req of entry.manifest.requires) {
      const candidates = (providers.get(req.capability) ?? []).filter((provider) => {
        if (!satisfies(provider.version, req.version)) return false;
        if (req.moduleId && provider.moduleId !== req.moduleId) return false;
        return true;
      });
      if (candidates.length === 0) {
        const message = `Module "${entry.manifest.moduleId}" requires capability "${req.capability}" ${req.version}${
          req.moduleId ? ` from "${req.moduleId}"` : ""
        }, and no admitted module provides it.`;
        if (req.optional) {
          diagnostics.push({
            severity: "warning",
            code: "dependency.optional-missing",
            message: `${message} It will run without that capability.`,
            phase: "resolve",
            moduleId: entry.manifest.moduleId,
          });
        } else {
          resolveFailed = true;
          diagnostics.push(
            errorDiagnostic("dependency.unsatisfied", message, { moduleId: entry.manifest.moduleId }),
          );
        }
        continue;
      }
      const distinct = new Map<string, { moduleId: string; version: string }>();
      for (const provider of candidates) {
        if (!distinct.has(provider.moduleId)) distinct.set(provider.moduleId, provider);
      }
      if (distinct.size > 1) {
        resolveFailed = true;
        const ids = [...distinct.keys()].sort(cmp);
        diagnostics.push(
          errorDiagnostic(
            "dependency.ambiguous",
            `Module "${entry.manifest.moduleId}" requires capability "${req.capability}" ${req.version}, and ${ids.length} modules provide it (${ids.join(", ")}). The host will not pick one.`,
            { moduleId: entry.manifest.moduleId, moduleIds: [entry.manifest.moduleId, ...ids] },
          ),
        );
        continue;
      }
      const provider = [...distinct.values()][0];
      if (!provider) continue;
      if (provider.moduleId === entry.manifest.moduleId) {
        resolveFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "dependency.cycle",
            `Module "${entry.manifest.moduleId}" requires capability "${req.capability}", which it provides itself.`,
            { moduleId: entry.manifest.moduleId, moduleIds: [entry.manifest.moduleId] },
          ),
        );
        continue;
      }
      edges.push([provider.moduleId, entry.manifest.moduleId]);
      links.push({
        providerId: provider.moduleId,
        dependentId: entry.manifest.moduleId,
        kind: "capability",
        ref: req.capability,
      });
    }
  }

  for (const link of connections) {
    const owner = slotOwner.get(link.slotId);
    if (owner && owner !== PLATFORM_OWNER) {
      edges.push([owner, link.moduleId]);
      links.push({
        providerId: owner,
        dependentId: link.moduleId,
        kind: "slot",
        ref: link.slotId,
      });
    }
  }

  const dependencies = settleDependencies(links);

  const cycle = findCycle(admittedIds, uniqueEdges(edges));
  if (cycle) {
    resolveFailed = true;
    diagnostics.push(
      errorDiagnostic(
        "dependency.cycle",
        `Dependency cycle: ${cycle.join(" → ")}. The host will not guess an order.`,
        { moduleIds: [...new Set(cycle)] },
      ),
    );
  }

  const depthMemo = new Map<string, number>();
  const depthOf = (moduleId: string, trail: string[]): number => {
    const cached = depthMemo.get(moduleId);
    if (cached !== undefined) return cached;
    if (trail.includes(moduleId)) return 0;
    const links = connections.filter((item) => item.moduleId === moduleId);
    if (links.length === 0) {
      depthMemo.set(moduleId, 0);
      return 0;
    }
    let depth = 0;
    for (const link of links) {
      const owner = slotOwner.get(link.slotId);
      if (!owner || owner === PLATFORM_OWNER) depth = Math.max(depth, 1);
      else depth = Math.max(depth, depthOf(owner, [...trail, moduleId]) + 1);
    }
    depthMemo.set(moduleId, depth);
    return depth;
  };

  if (!cycle) {
    for (const id of admittedIds) {
      const depth = depthOf(id, []);
      if (depth > maxDepth) {
        resolveFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "slot.depth",
            `Module "${id}" nests ${depth} slots deep. The limit is ${maxDepth}.`,
            { moduleId: id },
          ),
        );
      }
    }
  }

  const connectionsBySlot = new Map<string, string[]>();
  for (const link of connections) {
    const list = connectionsBySlot.get(link.slotId) ?? [];
    list.push(link.moduleId);
    connectionsBySlot.set(link.slotId, list);
  }

  const resolvedSlots: ResolvedSlot[] = [];
  for (const [slotId, decl] of [...slotDecl.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const connected = [...new Set(connectionsBySlot.get(slotId) ?? [])].sort(cmp);
    let status: SlotStatus = "ok";
    let contributors = connected;
    let contestedBy: string[] = [];
    if (isExclusiveSlot(decl.kind) && connected.length > 1) {
      status = decl.kind === "service" ? "ambiguous" : "conflict";
      contributors = [];
      contestedBy = connected;
      resolveFailed = true;
      const names = connected.join(", ");
      diagnostics.push(
        errorDiagnostic(
          decl.kind === "service" ? "slot.ambiguous" : "slot.conflict",
          decl.kind === "service"
            ? `Service slot "${slotId}" has ${connected.length} providers (${names}). The host will not pick one.`
            : `Slot "${slotId}" (${decl.kind}) allows one provider, but ${names} all connect. None were activated.`,
          { slotId, moduleIds: connected },
        ),
      );
    } else if (decl.required && connected.length === 0) {
      status = "missing";
      resolveFailed = true;
      const owner = slotOwner.get(slotId) ?? PLATFORM_OWNER;
      diagnostics.push(
        errorDiagnostic(
          "slot.missing",
          `Required slot "${slotId}" owned by "${owner}" has no provider.`,
          { slotId, moduleId: owner === PLATFORM_OWNER ? undefined : owner },
        ),
      );
    }
    resolvedSlots.push({
      slotId,
      ownerId: slotOwner.get(slotId) ?? PLATFORM_OWNER,
      kind: decl.kind,
      contract: decl.contract,
      contractVersion: decl.contractVersion,
      required: decl.required,
      description: decl.description,
      status,
      contributors,
      contestedBy,
    });
  }

  const order = cycle ? [] : (topoSort(admittedIds, uniqueEdges(edges)) ?? []);
  if (!cycle && order.length !== admittedIds.length) {
    resolveFailed = true;
    diagnostics.push(
      errorDiagnostic("dependency.cycle", "The module graph could not be ordered.", {
        moduleIds: admittedIds,
      }),
    );
  }

  const resolveErrorCount = diagnostics.slice(resolveErrorsAt).filter((item) => item.severity === "error").length;
  phases.push(
    phase(
      "resolve",
      resolveFailed ? "failed" : "completed",
      resolveFailed
        ? `Resolution refused the composition (${resolveErrorCount} error${resolveErrorCount === 1 ? "" : "s"}). Nothing was registered.`
        : `Resolved ${admittedIds.length} module${admittedIds.length === 1 ? "" : "s"} and ${resolvedSlots.length} slot${resolvedSlots.length === 1 ? "" : "s"}.`,
    ),
  );

  const guilty = new Set<string>();
  for (const item of diagnostics) {
    if (item.severity !== "error") continue;
    if (item.phase !== "resolve" && item.phase !== "register" && item.phase !== "initialize") continue;
    for (const id of indicted(item)) guilty.add(id);
  }

  const finishInactive = async (reason: string): Promise<CompositionResult> => {
    phases.push(phase("prepare", "skipped", reason));
    phases.push(phase("register", "skipped", reason));
    phases.push(phase("initialize", "skipped", reason));
    phases.push(phase("run", "skipped", reason));
    return abandon(assemble({
      profileName,
      trust,
      backendId,
      grants,
      limitsEnforced,
      backend,
      runtimeActive: false,
      phases,
      diagnostics,
      working,
      slots: resolvedSlots,
      order,
      dependencies,
      contributions: [],
      trace,
      shutdown: noopShutdown,
      guilty,
    }));
  };

  if (resolveFailed) {
    return await finishInactive("Skipped because resolution failed.");
  }

  phases.push(
    phase(
      "prepare",
      "completed",
      limitsEnforced
        ? `Prepared ${admitted.length} module context${admitted.length === 1 ? "" : "s"}. ${backendId} enforces the time and memory limits.`
        : `Prepared ${admitted.length} module context${admitted.length === 1 ? "" : "s"}. This backend does not enforce a sandbox or resource limits.`,
    ),
  );

  const declaredConnections = new Map<string, Set<string>>();
  for (const entry of admitted) {
    declaredConnections.set(
      entry.manifest.moduleId,
      new Set(entry.manifest.connectsTo.map((link) => link.slot)),
    );
  }

  const records: ContributionRecord[] = [];
  const enteredRegister: string[] = [];
  const keptByModule = new Map<string, unknown>();
  let registerFailed = false;
  const life = (moduleId: string): LifecycleContext =>
    Object.freeze({
      moduleId,
      ownedSlot: (slotId: string) => owned(records, slotOwner, moduleId, slotId),
      kept: () => keptByModule.get(moduleId),
    });

  const callHook = async (
    moduleId: string,
    hook: "register" | "initialize" | "shutdown",
    implementation: ModuleImplementation | undefined,
    args: readonly unknown[],
  ): Promise<string | undefined> => {
    const permissions = admitted.find((item) => item.manifest.moduleId === moduleId)?.manifest.permissions ?? [];
    const outcome = await session.invoke({
      moduleId,
      hook,
      implementation: implementation as Parameters<ExecutionSession["invoke"]>[0]["implementation"],
      args,
      permissions,
    });
    if (outcome.ok) return undefined;
    if (outcome.error instanceof Error && outcome.error.message) return outcome.error.message;
    return String(outcome.error);
  };

  const shutdownEntered = async (ids: readonly string[], fromPhase: "register" | "initialize") => {
    for (const moduleId of [...ids].reverse()) {
      const entry = admitted.find((item) => item.manifest.moduleId === moduleId);
      trace.push(`${moduleId}:shutdown`);
      const failure = await callHook(moduleId, "shutdown", entry?.implementation, [life(moduleId)]);
      if (failure) {
        diagnostics.push(
          errorDiagnostic(
            "lifecycle.exception",
            `Shutdown of "${moduleId}" failed during rollback: ${failure}`,
            { phase: fromPhase, moduleId },
          ),
        );
      }
    }
  };

  for (const moduleId of order) {
    const entry = admitted.find((item) => item.manifest.moduleId === moduleId);
    if (!entry) continue;
    enteredRegister.push(moduleId);
    const before = records.length;
    const localErrors = diagnostics.length;
    const failure = await callHook(moduleId, "register", entry.implementation, [
      Object.freeze({
        moduleId,
        contribute: (slotId: string, contribution: ContributionInput) => {
          acceptContribution(
            moduleId,
            slotId,
            contribution,
            declaredConnections,
            slotDecl,
            records,
            diagnostics,
            (payload) => backend.recognizesPayload(payload),
          );
        },
        keep(state: unknown) {
          if (keptByModule.has(moduleId)) {
            diagnostics.push(
              errorDiagnostic("save.duplicate-keep", `Module "${moduleId}" called keep more than once.`, {
                phase: "register",
                moduleId,
              }),
            );
            return;
          }
          keptByModule.set(moduleId, state);
        },
      }),
    ]);
    if (failure) {
      diagnostics.push(
        errorDiagnostic("lifecycle.exception", `Register of "${moduleId}" threw: ${failure}`, {
          phase: "register",
          moduleId,
        }),
      );
    }
    trace.push(`${moduleId}:register`);

    const mine = records.slice(before);
    for (const slotId of declaredConnections.get(moduleId) ?? []) {
      const produced = mine.filter((item) => item.slotId === slotId);
      const kind = slotDecl.get(slotId)?.kind;
      const refusedShape = diagnostics
        .slice(localErrors)
        .some((item) => item.code === "slot.contract" && item.slotId === slotId && item.moduleId === moduleId);
      if (produced.length === 0 && !refusedShape) {
        diagnostics.push(
          errorDiagnostic(
            "slot.empty-connection",
            `Module "${moduleId}" connects to "${slotId}" but registered no contribution.`,
            { phase: "register", moduleId, slotId },
          ),
        );
      } else if (kind && isExclusiveSlot(kind) && produced.length > 1) {
        diagnostics.push(
          errorDiagnostic(
            "slot.excess-contribution",
            `Module "${moduleId}" registered ${produced.length} contributions to exclusive slot "${slotId}".`,
            { phase: "register", moduleId, slotId },
          ),
        );
      }
    }

    if (diagnostics.length > localErrors) {
      registerFailed = true;
      records.splice(before);
      break;
    }
  }

  if (!registerFailed) {
    const seenContribution = new Set<string>();
    for (const record of records) {
      const key = `${record.slotId}:${record.id}`;
      if (seenContribution.has(key)) {
        registerFailed = true;
        diagnostics.push(
          errorDiagnostic(
            "slot.duplicate-contribution",
            `Contribution id "${record.id}" is already used in slot "${record.slotId}".`,
            { phase: "register", moduleId: record.moduleId, slotId: record.slotId },
          ),
        );
      }
      seenContribution.add(key);
    }
  }

  if (registerFailed) {
    await shutdownEntered(enteredRegister, "register");
    records.splice(0, records.length);
    phases.push(phase("register", "failed", "Registration failed. Registered modules were shut down and contributions discarded."));
    phases.push(phase("initialize", "skipped", "Skipped because registration failed."));
    phases.push(phase("run", "skipped", "Skipped because registration failed."));
    for (const item of diagnostics) {
      if (item.phase === "register" && item.severity === "error") {
        for (const id of indicted(item)) guilty.add(id);
      }
    }
    return abandon(assemble({
      profileName,
      trust,
      backendId,
      grants,
      limitsEnforced,
      backend,
      runtimeActive: false,
      phases,
      diagnostics,
      working,
      slots: resolvedSlots,
      order,
      dependencies,
      contributions: [],
      trace,
      shutdown: noopShutdown,
      guilty,
    }));
  }

  records.sort(contributionSort);
  phases.push(
    phase("register", "completed", `Registered ${records.length} contribution${records.length === 1 ? "" : "s"}.`),
  );

  const initialized: string[] = [];
  let initFailed = false;
  for (const moduleId of order) {
    const entry = admitted.find((item) => item.manifest.moduleId === moduleId);
    if (!entry) continue;
    try {
      const failure = await callHook(moduleId, "initialize", entry.implementation, [life(moduleId)]);
      if (failure) throw new Error(failure);
      initialized.push(moduleId);
      trace.push(`${moduleId}:initialize`);
    } catch (caught) {
      initFailed = true;
      const message = caught instanceof Error ? caught.message : String(caught);
      diagnostics.push(
        errorDiagnostic("lifecycle.exception", `Initialize of "${moduleId}" threw: ${message}`, {
          phase: "initialize",
          moduleId,
        }),
      );
      guilty.add(moduleId);
      await shutdownEntered([...initialized, moduleId], "initialize");
      break;
    }
  }

  if (initFailed) {
    phases.push(phase("initialize", "failed", "Initialization failed. Modules that had entered initialize were shut down. No contributions remain registered."));
    phases.push(phase("run", "skipped", "Skipped because initialization failed."));
    return abandon(assemble({
      profileName,
      trust,
      backendId,
      grants,
      limitsEnforced,
      backend,
      runtimeActive: false,
      phases,
      diagnostics,
      working,
      slots: resolvedSlots,
      order,
      dependencies,
      contributions: [],
      trace,
      shutdown: noopShutdown,
      guilty,
    }));
  }

  phases.push(
    phase(
      "initialize",
      "completed",
      `Initialized ${initialized.length} module${initialized.length === 1 ? "" : "s"} in topological order.`,
    ),
  );
  phases.push(
    phase(
      "run",
      "completed",
      "Runtime is active. There is no implicit tick. Callers read contributions and invoke payloads themselves.",
    ),
  );

  let built: CompositionResult;
  const shutdown = async (): Promise<ShutdownReport> => {
    if (built.quiesced) return { already: true, order: [], diagnostics: [] };
    built.quiesced = true;
    const shutdownDiagnostics: Diagnostic[] = [];
    const shutdownOrder = [...initialized].reverse();
    for (const moduleId of shutdownOrder) {
      const entry = admitted.find((item) => item.manifest.moduleId === moduleId);
      trace.push(`${moduleId}:shutdown`);
      const failure = await callHook(moduleId, "shutdown", entry?.implementation, [life(moduleId)]);
      if (failure) {
        shutdownDiagnostics.push(
          errorDiagnostic("lifecycle.exception", `Shutdown of "${moduleId}" threw: ${failure}`, {
            phase: "shutdown",
            moduleId,
          }),
        );
      }
    }
    await session.release();
    return { already: false, order: shutdownOrder, diagnostics: shutdownDiagnostics };
  };

  built = assemble({
    profileName,
    trust,
    backendId,
    grants,
    limitsEnforced,
    backend,
    runtimeActive: true,
    phases,
    diagnostics,
    working,
    slots: resolvedSlots,
    order,
    dependencies,
    contributions: records,
    trace,
    shutdown,
    guilty,
  });
  const implByModule = new Map<string, ModuleImplementation | undefined>();
  for (const entry of admitted) implByModule.set(entry.manifest.moduleId, entry.implementation);
  memoryOf.set(built, keptByModule);
  implOf.set(built, implByModule);
  sessionOfMap.set(built, session);
  retainSession = true;
  return built;
  } finally {
    if (!retainSession) await session.release();
  }
}

function acceptContribution(
  moduleId: string,
  slotId: string,
  contribution: ContributionInput,
  declaredConnections: Map<string, Set<string>>,
  slotDecl: Map<string, SlotExposeDecl>,
  records: ContributionRecord[],
  diagnostics: Diagnostic[],
  recognizesPayload: (payload: unknown) => boolean,
): void {
  if (!declaredConnections.get(moduleId)?.has(slotId)) {
    diagnostics.push(
      errorDiagnostic(
        "slot.undeclared",
        `Module "${moduleId}" tried to contribute to "${slotId}" without declaring that connection.`,
        { phase: "register", moduleId, slotId },
      ),
    );
    return;
  }
  if (!slotDecl.has(slotId)) {
    diagnostics.push(
      errorDiagnostic("slot.unknown", `Slot "${slotId}" is not in the resolved graph.`, {
        phase: "register",
        moduleId,
        slotId,
      }),
    );
    return;
  }
  if (typeof contribution?.id !== "string" || !CONTRIBUTION_ID_RE.test(contribution.id)) {
    diagnostics.push(
      errorDiagnostic(
        "manifest.field",
        `Contribution id from "${moduleId}" into "${slotId}" must be a short lowercase identifier.`,
        { phase: "register", moduleId, slotId, path: "contribution.id" },
      ),
    );
    return;
  }
  const order = contribution.order ?? 0;
  if (!Number.isInteger(order)) {
    diagnostics.push(
      errorDiagnostic(
        "manifest.field",
        `Contribution "${contribution.id}" has a non-integer order.`,
        { phase: "register", moduleId, slotId, path: "contribution.order" },
      ),
    );
    return;
  }
  if (contribution.payload === undefined) {
    diagnostics.push(
      errorDiagnostic(
        "manifest.field",
        `Contribution "${contribution.id}" is missing a payload.`,
        { phase: "register", moduleId, slotId, path: "contribution.payload" },
      ),
    );
    return;
  }
  const kind = slotDecl.get(slotId)?.kind;
  if (kind && slotRequiresCallable(kind) && !recognizesPayload(contribution.payload)) {
    diagnostics.push(
      errorDiagnostic(
        "slot.contract",
        `Contribution "${contribution.id}" into ${kind} slot "${slotId}" must be a function, or an object with a handle function.`,
        { phase: "register", moduleId, slotId },
      ),
    );
    return;
  }
  records.push({
    slotId,
    moduleId,
    id: contribution.id,
    order,
    payload: contribution.payload,
  });
}

function settleDependencies(links: ResolvedDependency[]): ResolvedDependency[] {
  const seen = new Set<string>();
  const unique: ResolvedDependency[] = [];
  for (const link of links) {
    const key = `${link.providerId}\0${link.dependentId}\0${link.kind}\0${link.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
  }
  unique.sort(
    (a, b) =>
      cmp(a.dependentId, b.dependentId) ||
      cmp(a.providerId, b.providerId) ||
      cmp(a.kind, b.kind) ||
      cmp(a.ref, b.ref),
  );
  return unique;
}

function uniqueEdges(edges: Array<[string, string]>): Array<[string, string]> {
  const seen = new Set<string>();
  const unique: Array<[string, string]> = [];
  for (const edge of edges) {
    const key = `${edge[0]}→${edge[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

function owned(
  records: readonly ContributionRecord[],
  slotOwner: Map<string, string>,
  moduleId: string,
  slotId: string,
): readonly ContributionRecord[] | undefined {
  if (slotOwner.get(slotId) !== moduleId) return undefined;
  return records
    .filter((item) => item.slotId === slotId)
    .map((item) => ({ ...item }));
}

function assemble(input: {
  profileName: string;
  trust: ExecutionTrust | "unsupported" | "custom";
  backendId: string;
  grants: readonly HostGrant[];
  limitsEnforced: boolean;
  backend?: ExecutionBackend;
  runtimeActive: boolean;
  phases: PhaseRecord[];
  diagnostics: Diagnostic[];
  working: WorkingModule[];
  slots: ResolvedSlot[];
  order: string[];
  dependencies: ResolvedDependency[];
  contributions: ContributionRecord[];
  trace: string[];
  shutdown: () => Promise<ShutdownReport>;
  guilty: Set<string>;
}): CompositionResult {
  const modules: ResolvedModule[] = input.working.map((item) => {
    let status: ModuleStatus;
    if (item.status === "rejected") status = "rejected";
    else if (!input.runtimeActive) status = input.guilty.has(item.moduleId) ? "rejected" : "blocked";
    else status = "active";
    const manifest = item.manifest;
    return {
      moduleId: item.moduleId,
      name: manifest?.name ?? item.name,
      version: manifest?.version ?? item.version,
      description: manifest?.description,
      status,
      manifest,
      provides: manifest?.provides ?? [],
      requires: manifest?.requires ?? [],
      connectsTo: manifest?.connectsTo ?? [],
      exposesSlots: manifest?.exposesSlots ?? [],
      permissions: manifest?.permissions ?? [],
      save: manifest?.save,
      author: manifest?.author,
      license: manifest?.license,
    };
  });

  // A module that never validated still shouldn't be marked active.
  const clean = input.diagnostics.every((item) => item.severity !== "error");
  const built: CompositionResult = {
    profileName: input.profileName,
    foundationsApi: FOUNDATIONS_API,
    trust: input.trust,
    backendId: input.backendId,
    grants: input.grants,
    limitsEnforced: input.limitsEnforced,
    ok: input.runtimeActive && clean,
    runtimeActive: input.runtimeActive,
    quiesced: false,
    phases: input.phases,
    diagnostics: input.diagnostics,
    modules,
    slots: input.slots,
    order: input.order,
    dependencies: input.dependencies,
    fingerprint: fingerprintOf(
      input.backendId,
      input.order,
      modules,
      input.slots,
      input.dependencies,
      input.contributions,
    ),
    contributions: input.runtimeActive ? input.contributions : [],
    trace: input.trace,
    shutdown: input.shutdown,
  };
  if (input.backend) backendOfMap.set(built, input.backend);
  return built;
}

const memoryOf = new WeakMap<CompositionResult, ReadonlyMap<string, unknown>>();
const implOf = new WeakMap<CompositionResult, ReadonlyMap<string, ModuleImplementation | undefined>>();
const backendOfMap = new WeakMap<CompositionResult, ExecutionBackend>();
const sessionOfMap = new WeakMap<CompositionResult, ExecutionSession>();

export function sessionOf(result: CompositionResult): ExecutionSession {
  return sessionOfMap.get(result) ?? deniedSession;
}

export function backendOf(result: CompositionResult): ExecutionBackend {
  return backendOfMap.get(result) ?? denyingBackend;
}

export function moduleMemory(result: CompositionResult, moduleId: string): unknown {
  return memoryOf.get(result)?.get(moduleId);
}

export function moduleImplementation(
  result: CompositionResult,
  moduleId: string,
): ModuleImplementation | undefined {
  return implOf.get(result)?.get(moduleId);
}

export function contributionsFor(
  result: CompositionResult,
  slotId: string,
): readonly ContributionRecord[] {
  return result.contributions.filter((item) => item.slotId === slotId);
}

export function moduleStatus(result: CompositionResult, moduleId: string): ModuleStatus | undefined {
  return result.modules.find((item) => item.moduleId === moduleId)?.status;
}
