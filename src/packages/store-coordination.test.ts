import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  withLocalStoreReadLock,
  withLocalStoreWriteLock,
} from "./local-store.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise() };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + label + ".");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-store-coordination-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("writer waits for active readers and prevents new readers entering", async (t) => {
  const store = fixture(t);
  const readerEntered = deferred();
  const releaseReader = deferred();
  const order: string[] = [];

  const firstReader = withLocalStoreReadLock(store, async () => {
    readerEntered.resolve();
    await releaseReader.promise;
    order.push("first-reader-finished");
  });
  await readerEntered.promise;

  let writerEntered = false;
  const writer = withLocalStoreWriteLock(store, () => {
    writerEntered = true;
    order.push("writer");
  });
  await waitFor(() => existsSync(join(store, ".cgp-store.lock")), "writer intent marker");

  let secondReaderEntered = false;
  const secondReader = withLocalStoreReadLock(store, () => {
    secondReaderEntered = true;
    order.push("second-reader");
  });

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(writerEntered, false);
    assert.equal(secondReaderEntered, false);
  } finally {
    releaseReader.resolve();
  }

  await Promise.all([firstReader, writer, secondReader]);
  assert.deepEqual(order, [
    "first-reader-finished",
    "writer",
    "second-reader",
  ]);
});

test("writer fails closed on a stale reader marker and leaves it for manual inspection", async (t) => {
  const store = fixture(t);
  const readerDirectory = join(store, ".cgp-store.readers");
  mkdirSync(readerDirectory);
  const staleMarker = join(readerDirectory, "stale-reader.json");
  writeFileSync(staleMarker, "{malformed marker\n");

  let operationRan = false;
  await assert.rejects(
    withLocalStoreWriteLock(store, () => {
      operationRan = true;
    }, { waitTimeoutMs: 30, pollIntervalMs: 5 }),
    /Timed out waiting for active or stale package-store reader markers/,
  );
  assert.equal(operationRan, false);
  assert.equal(existsSync(staleMarker), true);
  assert.equal(existsSync(join(store, ".cgp-store.lock")), false);
});

test("reader fails closed while a writer marker remains present", async (t) => {
  const store = fixture(t);
  writeFileSync(join(store, ".cgp-store.lock"), JSON.stringify({
    schema: "cgp.local-store-lock/1",
    token: "stale-writer",
    pid: 999999,
    createdAt: new Date(0).toISOString(),
  }) + "\n");

  let operationRan = false;
  await assert.rejects(
    withLocalStoreReadLock(store, () => {
      operationRan = true;
    }, { waitTimeoutMs: 30, pollIntervalMs: 5 }),
    /Timed out waiting for the package-store writer lock/,
  );
  assert.equal(operationRan, false);
});

test("reader marker is released when its callback throws", async (t) => {
  const store = fixture(t);
  await assert.rejects(
    withLocalStoreReadLock(store, () => {
      throw new Error("reader callback failed");
    }),
    /reader callback failed/,
  );

  let writerRan = false;
  await withLocalStoreWriteLock(store, () => {
    writerRan = true;
  });
  assert.equal(writerRan, true);
});


test("multiple readers can acquire the first store reader directory concurrently", async (t) => {
  const store = fixture(t);
  const bothEntered = deferred();
  const releaseReaders = deferred();
  let entered = 0;

  const makeReader = () => withLocalStoreReadLock(store, async () => {
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await releaseReaders.promise;
  });

  const first = makeReader();
  const second = makeReader();
  try {
    await bothEntered.promise;
    assert.equal(entered, 2);
  } finally {
    releaseReaders.resolve();
  }
  await Promise.all([first, second]);
});
