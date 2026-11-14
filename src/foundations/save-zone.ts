/**
 * Which composition a hook or lane body is running for, including after it awaits.
 * One frame carries the lane, the save hook, and a step-time direct mutation.
 * Node uses AsyncLocalStorage. It does not modify Promise.prototype.
 * Chromium has no async-context primitive, and native await does not call
 * Promise.prototype.then, so the browser bundle lowers await and the page binds
 * those reactions. That binder is not installed on Node.
 */

type ZoneFrame = {
  readonly composition: object;
  readonly lane: boolean;
  readonly save: boolean;
  /** An outside mutating service admitted while a step holds the lane. */
  readonly direct: boolean;
};

type SaveContext = {
  run<T>(frame: ZoneFrame, fn: () => T): T;
  current(): ZoneFrame | undefined;
};

type AsyncLocalStorageLike = {
  run<T>(store: ZoneFrame, callback: () => T): T;
  getStore(): ZoneFrame | undefined;
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
  let current: ZoneFrame | undefined;
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

function nested(composition: object, lane: boolean, save: boolean, direct: boolean): ZoneFrame {
  const outer = context.current();
  const same = outer?.composition === composition;
  return {
    composition,
    lane: lane || (same && outer.lane),
    save: save || (same && outer.save),
    direct: direct || (same && outer.direct),
  };
}

export function runInSaveZone<T>(composition: object, fn: () => T): T {
  return context.run(nested(composition, false, true, false), fn);
}

export function runInLane<T>(composition: object, fn: () => T): T {
  return context.run(nested(composition, true, false, false), fn);
}

/** Keeps a step-time service, and services it calls, off the lane until that call settles. */
export function runInDirectMutation<T>(composition: object, fn: () => T): T {
  return context.run(nested(composition, false, false, true), fn);
}

export function inSaveZone(composition: object): boolean {
  const frame = context.current();
  return frame?.composition === composition && frame.save;
}

export function inLane(composition: object): boolean {
  const frame = context.current();
  return frame?.composition === composition && frame.lane;
}

export function inDirectMutation(composition: object): boolean {
  const frame = context.current();
  return frame?.composition === composition && frame.direct;
}
