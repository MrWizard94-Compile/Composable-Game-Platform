/**
 * Tracks the hook or handler that is on the stack, including after it awaits.
 * A save call inside that chain is reentrant. A call from outside it is not.
 * The promise continuation keeps the mark so an awaited callback still counts.
 */

let current = false;
let patched = false;
const nativeThen = Promise.prototype.then;

function install(): void {
  if (patched) return;
  patched = true;
  Promise.prototype.then = function (this: Promise<unknown>, onFulfilled, onRejected) {
    const captured = current;
    const wrap = (fn: unknown) => {
      if (typeof fn !== "function") return fn;
      return (value: unknown) => {
        const previous = current;
        current = captured;
        try {
          return fn(value);
        } finally {
          current = previous;
        }
      };
    };
    return nativeThen.call(this, wrap(onFulfilled) as typeof onFulfilled, wrap(onRejected) as typeof onRejected);
  } as typeof Promise.prototype.then;
}

export function runInSaveZone<T>(fn: () => T): T {
  install();
  const previous = current;
  current = true;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

export function inSaveZone(): boolean {
  return current;
}
