import type { CompositionProfile } from "../foundations/profile.ts";
import badContract from "../../profiles/bad-contract.json" with { type: "json" };
import badDispatch from "../../profiles/bad-dispatch.json" with { type: "json" };
import cycle from "../../profiles/cycle.json" with { type: "json" };
import dispatch from "../../profiles/dispatch.json" with { type: "json" };
import initFailure from "../../profiles/init-failure.json" with { type: "json" };
import nestedProof from "../../profiles/nested-proof.json" with { type: "json" };
import policyConflict from "../../profiles/policy-conflict.json" with { type: "json" };
import secondPack from "../../profiles/second-pack.json" with { type: "json" };
import service from "../../profiles/service.json" with { type: "json" };
import twoServices from "../../profiles/two-services.json" with { type: "json" };
import twoProviders from "../../profiles/two-providers.json" with { type: "json" };
import wrongVersion from "../../profiles/wrong-version.json" with { type: "json" };

export const PROFILES: { id: string; profile: CompositionProfile }[] = [
  { id: "proof", profile: nestedProof },
  { id: "dispatch", profile: dispatch },
  { id: "dispatch-fault", profile: badDispatch },
  { id: "service", profile: service },
  { id: "service-clash", profile: twoServices },
  { id: "two-providers", profile: twoProviders },
  { id: "desert", profile: secondPack },
  { id: "conflict", profile: policyConflict },
  { id: "cycle", profile: cycle },
  { id: "mismatch", profile: badContract },
  { id: "crash", profile: initFailure },
  { id: "wrong-version", profile: wrongVersion },
];

export function profileIds(profile: CompositionProfile): string[] {
  return profile.modules.map((item) => item.moduleId);
}
