/** Minimal semantic versioning. ASCII, no pre-release tags. */

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
};

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemVer(input: string): SemVer | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatSemVer(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

type ComparatorOp = "=" | ">" | ">=" | "<" | "<=";

type Comparator = {
  op: ComparatorOp;
  version: SemVer;
};

function parseComparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(token.trim());
  if (!match) return null;
  const version = parseSemVer(match[2] ?? "");
  if (!version) return null;
  const op = (match[1] ?? "=") as ComparatorOp;
  return { op, version };
}

function matchesComparator(version: SemVer, comparator: Comparator): boolean {
  const diff = compareSemVer(version, comparator.version);
  switch (comparator.op) {
    case "=":
      return diff === 0;
    case ">":
      return diff > 0;
    case ">=":
      return diff >= 0;
    case "<":
      return diff < 0;
    case "<=":
      return diff <= 0;
    default:
      return false;
  }
}

/**
 * Ranges:
 * - `1.2.3` exact
 * - `^1.2.3` compatible within the leading non-zero component
 * - `~1.2.3` same major.minor, patch >= base
 * - `>=1.0.0 <2.0.0` every whitespace-separated comparator must match
 */
export function isValidRange(range: string): boolean {
  const text = range.trim();
  if (!text) return false;
  if (text.startsWith("^") || text.startsWith("~")) {
    return parseSemVer(text.slice(1).trim()) !== null && !/\s/.test(text.slice(1).trim());
  }
  const parts = text.split(/\s+/);
  if (parts.length === 0) return false;
  return parts.every((part) => parseComparator(part) !== null);
}

export function satisfies(versionText: string, rangeText: string): boolean {
  const version = parseSemVer(versionText);
  if (!version || !isValidRange(rangeText)) return false;
  const range = rangeText.trim();

  if (range.startsWith("^") || range.startsWith("~")) {
    const base = parseSemVer(range.slice(1).trim());
    if (!base || compareSemVer(version, base) < 0) return false;
    if (range.startsWith("~")) {
      return version.major === base.major && version.minor === base.minor;
    }
    if (base.major > 0) return version.major === base.major;
    if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
    return version.major === 0 && version.minor === 0 && version.patch === base.patch;
  }

  return range.split(/\s+/).every((part) => {
    const comparator = parseComparator(part);
    return comparator !== null && matchesComparator(version, comparator);
  });
}

export type ContractRef = {
  id: string;
  major: number;
  exact: SemVer | null;
};

const CONTRACT_ID_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/** `contract.id/1` (major) or `contract.id/1.2.3` (exact). */
export function parseContractRef(ref: string): ContractRef | null {
  const slash = ref.lastIndexOf("/");
  if (slash <= 0) return null;
  const id = ref.slice(0, slash);
  const versionText = ref.slice(slash + 1);
  if (!CONTRACT_ID_RE.test(id)) return null;
  if (/^(0|[1-9]\d*)$/.test(versionText)) {
    return { id, major: Number(versionText), exact: null };
  }
  const exact = parseSemVer(versionText);
  if (!exact) return null;
  return { id, major: exact.major, exact };
}

export function contractRefMatches(ref: ContractRef, contractId: string, contractVersion: string): boolean {
  if (ref.id !== contractId) return false;
  const declared = parseSemVer(contractVersion);
  if (!declared || declared.major !== ref.major) return false;
  if (ref.exact && compareSemVer(ref.exact, declared) !== 0) return false;
  return true;
}
