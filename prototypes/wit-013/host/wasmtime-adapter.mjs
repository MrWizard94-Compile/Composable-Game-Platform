import { spawn } from "node:child_process";

function start(bin) {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    while (waiters.length > 0) waiters.shift().reject(failure);
  });
  child.on("exit", (code) => {
    const error = new Error(stderr || `wasmtime-host exited ${code}`);
    while (waiters.length > 0) waiters.shift().reject(error);
  });
  child.stdin.on("error", () => {});
  function ask(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`wasmtime-host timed out on ${message.cmd}\n${stderr}`));
      }, 10000);
      waiters.push({
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  return { ask, child, stderr: () => stderr };
}

function meterValue(reply) {
  if (!reply.ok) throw new Error(reply.error || "wasmtime call failed");
  if (reply.guestOk === false) {
    const lower = String(reply.error).toLowerCase();
    const error = lower.includes("overflow") ? "overflow" : lower.includes("refused") ? "refused" : lower;
    return { ok: false, error };
  }
  if (reply.label !== undefined) return { ok: true, value: reply.value, label: reply.label };
  return { ok: true, value: reply.value };
}

export function openWasmtime(bin, componentPath) {
  const proc = start(bin);
  let loaded = false;
  async function ensure() {
    if (loaded) return;
    const reply = await proc.ask({ cmd: "load", path: componentPath });
    if (!reply.ok) throw new Error(reply.error || "load failed");
    loaded = true;
    return reply;
  }
  return {
    async load() {
      return ensure();
    },
    async calls() {
      await ensure();
      const reply = await proc.ask({ cmd: "calls" });
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
    async read() {
      await ensure();
      return meterValue(await proc.ask({ cmd: "read" }));
    },
    async add(delta) {
      await ensure();
      return meterValue(await proc.ask({ cmd: "add", delta }));
    },
    async contributions() {
      await ensure();
      const reply = await proc.ask({ cmd: "contributions" });
      if (!reply.ok) throw new Error(reply.error);
      return reply.contributions;
    },
    async live() {
      await ensure();
      const reply = await proc.ask({ cmd: "live" });
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
    async issue(moduleId, composition) {
      await ensure();
      const reply = await proc.ask({ cmd: "issue", moduleId, composition });
      if (!reply.ok) throw new Error(reply.error);
      return reply.handle;
    },
    async peek(handle) {
      await ensure();
      const reply = await proc.ask({ cmd: "peek", handle });
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
    async consume(handle) {
      await ensure();
      const reply = await proc.ask({ cmd: "consume", handle });
      if (!reply.ok) throw new Error(reply.error);
      if (reply.guestOk === false) throw new Error(reply.error);
      return reply.value;
    },
    async drop(handle) {
      await ensure();
      const reply = await proc.ask({ cmd: "drop", handle });
      if (!reply.ok) throw new Error(reply.error);
    },
    async release() {
      if (loaded) {
        await proc.ask({ cmd: "shutdown" }).catch(() => {});
      }
      proc.child.kill();
    },
    raw: proc,
  };
}

export async function wasmtimeImports(bin, componentPath) {
  const proc = start(bin);
  try {
    const reply = await proc.ask({ cmd: "imports", path: componentPath });
    if (!reply.ok) throw new Error(reply.error);
    return reply.imports;
  } finally {
    proc.child.kill();
  }
}

export async function wasmtimeTryInstantiate(bin, componentPath) {
  const proc = start(bin);
  try {
    const reply = await proc.ask({ cmd: "try-instantiate", path: componentPath });
    if (!reply.ok) return { instantiated: false, error: reply.error || "try-instantiate failed" };
    return { instantiated: reply.instantiated === true, error: reply.error || "" };
  } finally {
    proc.child.kill();
  }
}
