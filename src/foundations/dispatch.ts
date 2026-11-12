import type { CompositionResult, ContributionRecord } from "./host.ts";
import { backendOf, contributionsFor } from "./host.ts";

/**
 * Caller-initiated execution for three slot kinds.
 *
 * A payload is a function, or an object whose `handle` is a function.
 * The host does not interpret any other field.
 *
 * `publish` calls every subscriber, in contribution order. A throw or a missing
 * function is recorded and the rest still run.
 *
 * `runPipeline` feeds the previous value in. The first throw, missing function,
 * or `undefined` return stops the fold. The output stays at the last accepted value.
 *
 * `callService` calls the one provider of a service slot and returns its value,
 * including `undefined`. It does not pick among several providers.
 *
 * None of these start a tick, and none of them change the composition.
 */

export type DispatchCode = "dispatch.threw" | "dispatch.not-callable" | "dispatch.undefined";

export type PublishDelivery = {
  contributionId: string;
  moduleId: string;
  ok: boolean;
  code?: Exclude<DispatchCode, "dispatch.undefined">;
  message?: string;
};

export type PublishReport = {
  ok: boolean;
  slotId: string;
  deliveries: PublishDelivery[];
  reason?: string;
};

export type PipelineStage = {
  contributionId: string;
  moduleId: string;
  ok: boolean;
  output?: unknown;
  code?: DispatchCode;
  message?: string;
};

export type PipelineReport = {
  ok: boolean;
  slotId: string;
  output: unknown;
  stages: PipelineStage[];
  reason?: string;
};

export type ServiceReport = {
  ok: boolean;
  slotId: string;
  output?: unknown;
  contributionId?: string;
  moduleId?: string;
  code?: Exclude<DispatchCode, "dispatch.undefined">;
  message?: string;
  reason?: string;
};

const NOT_CALLABLE = Symbol("not-callable");

function callHandler(result: CompositionResult, payload: unknown, arg: unknown): unknown | typeof NOT_CALLABLE {
  const outcome = backendOf(result).callPayload(payload, arg);
  if (!outcome.ok && outcome.code === "not-callable") return NOT_CALLABLE;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The handler threw a non-error value.";
}

function verbFor(kind: "subscriber" | "pipeline" | "service"): string {
  if (kind === "subscriber") return "publish()";
  if (kind === "pipeline") return "runPipeline()";
  return "callService()";
}

function refuse(slotId: string, result: CompositionResult, kind: "subscriber" | "pipeline" | "service"): string | undefined {
  if (result.quiesced) return "Runtime has shut down.";
  if (!result.runtimeActive) return "Runtime is not active.";
  const slot = result.slots.find((item) => item.slotId === slotId);
  if (!slot) return `Slot "${slotId}" is not in this composition.`;
  if (slot.kind !== kind) {
    return `Slot "${slotId}" is a ${slot.kind}. ${verbFor(kind)} only runs ${kind} slots.`;
  }
  if (slot.status !== "ok") return `Slot "${slotId}" is ${slot.status}. Nothing was called.`;
  return undefined;
}

export function publish(result: CompositionResult, slotId: string, event: unknown): PublishReport {
  const reason = refuse(slotId, result, "subscriber");
  if (reason) return { ok: false, slotId, deliveries: [], reason };

  const deliveries: PublishDelivery[] = [];
  for (const contribution of contributionsFor(result, slotId)) {
    deliveries.push(deliver(result, contribution, event));
  }
  return {
    ok: deliveries.every((item) => item.ok),
    slotId,
    deliveries,
  };
}

function deliver(result: CompositionResult, contribution: ContributionRecord, event: unknown): PublishDelivery {
  try {
    const returned = callHandler(result, contribution.payload, event);
    if (returned === NOT_CALLABLE) {
      return {
        contributionId: contribution.id,
        moduleId: contribution.moduleId,
        ok: false,
        code: "dispatch.not-callable",
        message: `Subscriber "${contribution.id}" has no function payload or handle.`,
      };
    }
    return { contributionId: contribution.id, moduleId: contribution.moduleId, ok: true };
  } catch (error) {
    return {
      contributionId: contribution.id,
      moduleId: contribution.moduleId,
      ok: false,
      code: "dispatch.threw",
      message: thrownMessage(error),
    };
  }
}

export function runPipeline(result: CompositionResult, slotId: string, input: unknown): PipelineReport {
  const reason = refuse(slotId, result, "pipeline");
  if (reason) return { ok: false, slotId, output: input, stages: [], reason };

  let value = input;
  const stages: PipelineStage[] = [];
  for (const contribution of contributionsFor(result, slotId)) {
    let returned: unknown | typeof NOT_CALLABLE;
    try {
      returned = callHandler(result, contribution.payload, value);
    } catch (error) {
      stages.push({
        contributionId: contribution.id,
        moduleId: contribution.moduleId,
        ok: false,
        code: "dispatch.threw",
        message: thrownMessage(error),
      });
      return { ok: false, slotId, output: value, stages };
    }
    if (returned === NOT_CALLABLE) {
      stages.push({
        contributionId: contribution.id,
        moduleId: contribution.moduleId,
        ok: false,
        code: "dispatch.not-callable",
        message: `Stage "${contribution.id}" has no function payload or handle.`,
      });
      return { ok: false, slotId, output: value, stages };
    }
    if (returned === undefined) {
      stages.push({
        contributionId: contribution.id,
        moduleId: contribution.moduleId,
        ok: false,
        code: "dispatch.undefined",
        message: `Stage "${contribution.id}" returned undefined. The previous value was kept.`,
      });
      return { ok: false, slotId, output: value, stages };
    }
    value = returned;
    stages.push({
      contributionId: contribution.id,
      moduleId: contribution.moduleId,
      ok: true,
      output: value,
    });
  }
  return { ok: true, slotId, output: value, stages };
}

export function callService(result: CompositionResult, slotId: string, input: unknown): ServiceReport {
  const reason = refuse(slotId, result, "service");
  if (reason) return { ok: false, slotId, reason };

  const providers = contributionsFor(result, slotId);
  if (providers.length === 0) {
    return { ok: false, slotId, reason: `Service slot "${slotId}" has no provider.` };
  }
  if (providers.length > 1) {
    return {
      ok: false,
      slotId,
      reason: `Service slot "${slotId}" has ${providers.length} providers. Nothing was called.`,
    };
  }

  const contribution = providers[0];
  if (!contribution) return { ok: false, slotId, reason: `Service slot "${slotId}" has no provider.` };
  try {
    const returned = callHandler(result, contribution.payload, input);
    if (returned === NOT_CALLABLE) {
      return {
        ok: false,
        slotId,
        contributionId: contribution.id,
        moduleId: contribution.moduleId,
        code: "dispatch.not-callable",
        message: `Service "${contribution.id}" has no function payload or handle.`,
      };
    }
    return {
      ok: true,
      slotId,
      output: returned,
      contributionId: contribution.id,
      moduleId: contribution.moduleId,
    };
  } catch (error) {
    return {
      ok: false,
      slotId,
      contributionId: contribution.id,
      moduleId: contribution.moduleId,
      code: "dispatch.threw",
      message: thrownMessage(error),
    };
  }
}
