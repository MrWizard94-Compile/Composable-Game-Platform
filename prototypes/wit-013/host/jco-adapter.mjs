import { guestErrorName } from "./policy.mjs";

async function meterResult(body) {
  try {
    const value = await body();
    if (value && typeof value === "object" && "label" in value) {
      return { ok: true, value: value.value, label: value.label };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: guestErrorName(error) };
  }
}

export function adaptJco(root) {
  let stopped = false;
  return {
    async calls() {
      return await root.meter.calls();
    },
    read() {
      return meterResult(() => root.meter.read());
    },
    add(delta) {
      return meterResult(() => root.meter.add(delta));
    },
    async contributions() {
      return await root.registry.contributions();
    },
    async live() {
      return await root.passes.live();
    },
    async issue(moduleId, composition) {
      return await root.passes.issue(moduleId, composition);
    },
    async peek(handle) {
      return await root.passes.peek(handle);
    },
    async consume(handle) {
      return await root.passes.consume(handle);
    },
    async drop(handle) {
      if (handle && typeof handle[Symbol.dispose] === "function") handle[Symbol.dispose]();
    },
    async release() {
      if (stopped) return;
      stopped = true;
      await root._util.whenIdle();
      root._util.stop();
    },
  };
}

export async function openJco(moduleUrl, loadWasm) {
  const imported = await import(moduleUrl);
  const root = await imported.instantiate(loadWasm, {});
  return adaptJco(root);
}
