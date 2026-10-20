import test from "node:test";
import assert from "node:assert/strict";
import { planChunks } from "../src/render.mjs";

const sizes = (plan) => plan.map((c) => c.b - c.a);

function assertContiguous(plan, first, last) {
  if (last <= first) return assert.equal(plan.length, 0);
  assert.equal(plan[0].a, first);
  assert.equal(plan.at(-1).b, last);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].a, plan[i - 1].b);
  for (const c of plan) assert.ok(c.b > c.a, "segment must not be empty");
}

test("default 48 frames across 2 workers balance 24+24", () => {
  assert.deepEqual(sizes(planChunks(0, 48, undefined, 2)), [24, 24]);
});

test("default uneven totals differ by at most one frame", () => {
  assert.deepEqual(sizes(planChunks(0, 49, undefined, 2)), [25, 24]);
  assert.deepEqual(sizes(planChunks(0, 50, undefined, 4)), [13, 13, 12, 12]);
});

test("default single worker keeps short clips in one segment", () => {
  assert.deepEqual(sizes(planChunks(0, 48, undefined, 1)), [48]);
});

test("default splits long renders at the 120-frame segment ceiling", () => {
  assert.deepEqual(sizes(planChunks(0, 130, undefined, 1)), [65, 65]);
  assert.deepEqual(sizes(planChunks(0, 240, undefined, 1)), [120, 120]);
  assert.deepEqual(sizes(planChunks(0, 241, undefined, 1)), [81, 80, 80]);
});

test("tiny ranges never produce empty segments", () => {
  assert.deepEqual(sizes(planChunks(0, 1, undefined, 2)), [1]);
  assert.deepEqual(sizes(planChunks(0, 3, undefined, 8)), [1, 1, 1]);
});

test("zero or negative ranges produce no segments", () => {
  assert.deepEqual(planChunks(5, 5, undefined, 2), []);
  assert.deepEqual(planChunks(9, 4, 30, 2), []);
});

test("explicit chunk is respected regardless of workers", () => {
  assert.deepEqual(sizes(planChunks(0, 48, 30, 2)), [30, 18]);
  assert.deepEqual(sizes(planChunks(0, 48, 24, 2)), [24, 24]);
  assert.deepEqual(sizes(planChunks(0, 48, 6, 2)), [6, 6, 6, 6, 6, 6, 6, 6]);
  assert.deepEqual(sizes(planChunks(0, 48, 500, 2)), [48]);
});

test("ranges with an offset stay contiguous across the whole span", () => {
  for (const [first, last] of [
    [10, 58],
    [0, 1],
    [7, 8],
    [0, 121],
    [3, 500],
  ]) {
    for (const workers of [1, 2, 3])
      assertContiguous(
        planChunks(first, last, undefined, workers),
        first,
        last,
      );
    for (const chunk of [1, 7, 30, 120])
      assertContiguous(planChunks(first, last, chunk, 2), first, last);
  }
});
