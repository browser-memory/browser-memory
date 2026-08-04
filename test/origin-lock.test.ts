import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { acquireOrigin, resetOriginLocks } = await import(
  "../src/browser/origin-lock.ts"
);

beforeEach(() => resetOriginLocks());

const tick = () => new Promise<void>((r) => setImmediate(r));

test("shared holders run concurrently", async () => {
  const a = await acquireOrigin("o", false);
  const b = await acquireOrigin("o", false);
  // Both acquired without either releasing: concurrent.
  a.release();
  b.release();
});

test("exclusive waits for shared holders and blocks later shareds (FIFO)", async () => {
  const order: string[] = [];
  const s1 = await acquireOrigin("o", false);

  let exHeld = false;
  const ex = acquireOrigin("o", true).then((h) => {
    exHeld = true;
    order.push("ex");
    return h;
  });
  await tick();
  assert.equal(exHeld, false, "exclusive must wait for the shared holder");

  // A shared arriving AFTER the queued exclusive must not overtake it.
  let s2Held = false;
  const s2 = acquireOrigin("o", false).then((h) => {
    s2Held = true;
    order.push("s2");
    return h;
  });
  await tick();
  assert.equal(s2Held, false, "late shared must queue behind the exclusive");

  s1.release();
  const exHold = await ex;
  assert.equal(s2Held, false, "shared still blocked while exclusive runs");
  exHold.release();
  const s2Hold = await s2;
  s2Hold.release();
  assert.deepEqual(order, ["ex", "s2"]);
});

test("two exclusives serialize", async () => {
  const a = await acquireOrigin("o", true);
  let bHeld = false;
  const b = acquireOrigin("o", true).then((h) => {
    bHeld = true;
    return h;
  });
  await tick();
  assert.equal(bHeld, false);
  a.release();
  (await b).release();
});

test("downgrade admits queued shareds without releasing", async () => {
  const ex = await acquireOrigin("o", true);
  let sHeld = false;
  const s = acquireOrigin("o", false).then((h) => {
    sHeld = true;
    return h;
  });
  await tick();
  assert.equal(sHeld, false, "shared blocked while exclusive holds");

  ex.downgrade();
  const sHold = await s;
  assert.equal(sHeld, true, "downgrade lets shareds in");
  // The downgraded holder now releases as a shared holder; the lock must end idle.
  ex.release();
  sHold.release();
  const again = await acquireOrigin("o", true); // would hang if the count leaked
  again.release();
});

test("different keys do not contend", async () => {
  const a = await acquireOrigin("a", true);
  const b = await acquireOrigin("b", true); // acquired immediately
  a.release();
  b.release();
});

test("release is idempotent", async () => {
  const a = await acquireOrigin("o", true);
  a.release();
  a.release(); // second release must not corrupt the count
  const b = await acquireOrigin("o", true);
  b.release();
});
