/**
 * Which composition a hook is running for, including after that hook awaits.
 * Node uses AsyncLocalStorage. It does not modify Promise.prototype.
 * Chromium has no async-context primitive, so the page binds promise reactions
 * to the composition frame. That binder is not installed on Node.
 */

type SaveFrame = { readonly composition: object };

type SaveContext = {
  run<T>(frame: SaveFrame, fn: () => T): T;
  current(): SaveFrame | undefined;
};

type AsyncLocalStorageLike = {
  run<T>(store: SaveFrame, callback: () => T): T;
  getStore(): SaveFrame | undefined;
};

function nodeContext(): SaveContext | undefined {
  const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.(
    "node:async_hooks",
  ) as { AsyncLocalStorage?: new () => AsyncLocalStorageLike } | undefined;
  const Storage = builtin?.AsyncLocalStorage;
  if (!Storage) return undefined;
  const storage = new Storage();
  return {
    run(frame, fn) {
      return storage.run(frame, fn);
    },
    current() {
      return storage.getStore();
    },
  };
}

function browserContext(): SaveContext {
  let current: SaveFrame | undefined;
  let installed = false;
  const nativeThen = Promise.prototype.then;
  return {
    run(frame, fn) {
      if (!installed) {
        installed = true;
        Promise.prototype.then = function (this: Promise<unknown>, onFulfilled, onRejected) {
          const captured = current;
          const wrap = (listener: unknown) => {
            if (typeof listener !== "function") return listener;
            return (value: unknown) => {
              const previous = current;
              current = captured;
              try {
                return listener(value);
              } finally {
                current = previous;
              }
            };
          };
          return nativeThen.call(
            this,
            wrap(onFulfilled) as typeof onFulfilled,
            wrap(onRejected) as typeof onRejected,
          );
        } as typeof Promise.prototype.then;
      }
      const previous = current;
      current = frame;
      try {
        return fn();
      } finally {
        current = previous;
      }
    },
    current() {
      return current;
    },
  };
}

const context: SaveContext = nodeContext() ?? browserContext();

export function runInSaveZone<T>(composition: object, fn: () => T): T {
  return context.run({ composition }, fn);
}

export function inSaveZone(composition: object): boolean {
  return context.current()?.composition === composition;
}
