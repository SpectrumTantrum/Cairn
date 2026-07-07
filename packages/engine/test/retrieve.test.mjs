import assert from "node:assert/strict";
import { test } from "node:test";

const { sanitizeForFts, rrfFuse } = await import("../dist/retrieve.js");

test("sanitizeForFts quotes tokens and joins with OR", () => {
  assert.equal(sanitizeForFts("cache invalidation"), '"cache" OR "invalidation"');
  assert.equal(sanitizeForFts('say "hello"'), '"say" OR "hello"');
  assert.equal(sanitizeForFts("!!!"), "");
});

test("rrfFuse promotes ids appearing in multiple ranked arms", () => {
  const fused = rrfFuse([
    [10, 30],
    [10, 20],
  ]);
  assert.equal(fused[0].id, 10);
  assert.ok(fused[0].score > fused[1].score);
});

test("rrfFuse returns descending RRF scores", () => {
  const fused = rrfFuse([[1, 2, 3]]);
  for (let i = 1; i < fused.length; i++) {
    assert.ok(fused[i - 1].score >= fused[i].score);
  }
});
