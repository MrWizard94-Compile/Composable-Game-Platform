export const WIT_PACKAGE = "cgp:slot-probe@0.1.0";
export const COMPOSITION_ID = "comp-9";
export const OTHER_COMPOSITION_ID = "comp-other";

export const MODULES = {
  rust: {
    moduleId: "org.example.rust-meter",
    version: "1.4.2",
    label: "rust-meter",
  },
  js: {
    moduleId: "org.example.js-meter",
    version: "2.0.1",
    label: "js-meter",
  },
};

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function byRegistryOrder(left, right) {
  return (
    left.order - right.order ||
    compareText(left.moduleId, right.moduleId) ||
    compareText(left.id, right.id)
  );
}

export function guestErrorName(error) {
  if (typeof error === "string") return error.toLowerCase();
  if (error && typeof error.payload === "string") return error.payload.toLowerCase();
  const text = String(error && error.message ? error.message : error).toLowerCase();
  if (text.includes("overflow")) return "overflow";
  if (text.includes("refused")) return "refused";
  return text;
}

export function createHost(compositionId) {
  let closed = false;
  const tokens = new Map();
  let nextToken = 1;
  let nextAsync = 1;
  const queues = new Map();
  const pending = new Map();

  function queueFor(moduleId) {
    let queue = queues.get(moduleId);
    if (!queue) {
      queue = [];
      queues.set(moduleId, queue);
    }
    return queue;
  }

  return {
    compositionId,
    get closed() {
      return closed;
    },
    selectService(candidates, explicitId) {
      const authorized = candidates.filter((item) => item.authorized);
      if (explicitId) {
        const found = authorized.find((item) => item.moduleId === explicitId);
        if (!found) return { ok: false, code: "slot.missing", moduleId: explicitId };
        return { ok: true, provider: found };
      }
      if (authorized.length === 0) return { ok: false, code: "slot.missing" };
      if (authorized.length > 1) return { ok: false, code: "slot.ambiguous" };
      return { ok: true, provider: authorized[0] };
    },
    async callMeter(provider, method, arg, authorized) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      if (!authorized) return { ok: false, code: "slot.unauthorized" };
      if (method === "calls") return { ok: true, value: await provider.calls() };
      if (method === "read") return provider.read();
      if (method === "add") return provider.add(arg);
      return { ok: false, code: "slot.unknown" };
    },
    collect(candidates) {
      const admitted = [];
      for (const candidate of candidates) {
        if (!candidate.authorized) continue;
        for (const item of candidate.contributions) {
          admitted.push({
            id: item.id,
            order: item.order,
            label: item.label,
            moduleId: candidate.moduleId,
          });
        }
      }
      return admitted;
    },
    registry(candidates) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      const admitted = this.collect(candidates);
      const grouped = new Map();
      for (const item of admitted) {
        const list = grouped.get(item.id) ?? [];
        list.push(item);
        grouped.set(item.id, list);
      }
      const duplicateIds = [...grouped.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([id]) => id);
      if (duplicateIds.length > 0) {
        return {
          ok: false,
          code: "slot.duplicate-contribution",
          id: duplicateIds[0],
          duplicateIds,
        };
      }
      admitted.sort(byRegistryOrder);
      return { ok: true, contributions: admitted };
    },
    orderWitness(candidates) {
      const admitted = this.collect(candidates);
      const counts = new Map();
      for (const item of admitted) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      return admitted
        .filter((item) => counts.get(item.id) === 1)
        .sort(byRegistryOrder)
        .map((item) => ({ id: item.id, order: item.order, moduleId: item.moduleId }));
    },
    async issue(provider, moduleId) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      const handle = await provider.issue(moduleId, compositionId);
      const token = `tok-${nextToken++}`;
      tokens.set(token, {
        token,
        moduleId,
        compositionId,
        handle,
        provider,
        state: "live",
      });
      return { ok: true, token };
    },
    lookup(token, composition, moduleId) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      const record = tokens.get(token);
      if (!record) return { ok: false, code: "resource.forged" };
      if (record.state !== "live") return { ok: false, code: "resource.stale" };
      if (record.compositionId !== composition) return { ok: false, code: "resource.cross-composition" };
      if (record.moduleId !== moduleId) return { ok: false, code: "resource.cross-module" };
      return { ok: true, record };
    },
    async peek(token, composition, moduleId) {
      const found = this.lookup(token, composition, moduleId);
      if (!found.ok) return found;
      return { ok: true, value: await found.record.provider.peek(found.record.handle) };
    },
    async consume(token, composition, moduleId) {
      const found = this.lookup(token, composition, moduleId);
      if (!found.ok) return found;
      found.record.state = "consumed";
      return { ok: true, value: await found.record.provider.consume(found.record.handle) };
    },
    async drop(token, composition, moduleId) {
      const found = this.lookup(token, composition, moduleId);
      if (!found.ok) return found;
      found.record.state = "dropped";
      await found.record.provider.drop(found.record.handle);
      return { ok: true };
    },
    propose(moduleId, delta) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      queueFor(moduleId).push({ delta });
      return { ok: true, queued: true };
    },
    cancel(moduleId) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      queues.set(moduleId, []);
      return { ok: true, queued: false };
    },
    beginAsync(moduleId, delta) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      const id = `async-${nextAsync++}`;
      pending.set(id, { id, moduleId, delta, state: "pending" });
      return { ok: true, id, applied: false };
    },
    completeAsync(id, result) {
      const item = pending.get(id);
      if (!item) return { ok: false, code: "async.unknown", applied: false };
      if (item.state === "cancelled") return { ok: false, code: "async.cancelled", applied: false };
      if (item.state !== "pending" || closed) {
        item.state = "dropped";
        return { ok: false, code: closed ? "composition.shutdown" : "async.late", applied: false };
      }
      item.state = "completed";
      if (!result.ok) return { ok: true, applied: false, failed: true };
      queueFor(item.moduleId).push({ delta: item.delta });
      return { ok: true, applied: false, queued: true };
    },
    cancelAsync(id) {
      const item = pending.get(id);
      if (!item || item.state !== "pending") return { ok: false, code: "async.unknown" };
      item.state = "cancelled";
      return { ok: true, applied: false };
    },
    async commit(provider, moduleId) {
      if (closed) return { ok: false, code: "composition.shutdown" };
      const batch = queueFor(moduleId).splice(0);
      const applied = [];
      for (const item of batch) applied.push(await provider.add(item.delta));
      return { ok: true, applied };
    },
    shutdown() {
      closed = true;
      for (const record of tokens.values()) {
        if (record.state === "live") record.state = "shutdown";
      }
      queues.clear();
      for (const item of pending.values()) {
        if (item.state === "pending") item.state = "dropped";
      }
    },
  };
}
