import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  accuracyDecisionScore,
  decisionScore,
  distributionOf,
  labelFields,
  majorityBaseline,
  priorBrierLoss,
} from "../src/baseline.ts";

const close = (got: number, want: number, within = 1e-9) =>
  assert.ok(Math.abs(got - want) <= within, `${got} is not ${want} within ${within}`);

// A distribution small enough to do on paper: 5 a, 3 b, 2 c out of 10.
// Base rates 0.5, 0.3, 0.2.
// An item labelled a scores (0.5-1)^2 + 0.3^2 + 0.2^2 = 0.25 + 0.09 + 0.04 = 0.38
// An item labelled b scores 0.25 + (0.3-1)^2 + 0.04 = 0.25 + 0.49 + 0.04 = 0.78
// An item labelled c scores 0.25 + 0.09 + (0.2-1)^2 = 0.25 + 0.09 + 0.64 = 0.98
// Mean = (5*0.38 + 3*0.78 + 2*0.98) / 10 = (1.9 + 2.34 + 1.96) / 10 = 0.62
const HAND = [..."aaaaa", ..."bbb", ..."cc"];

test("the hand-built distribution's majority baseline and prior Brier are the numbers on paper", () => {
  const d = distributionOf(HAND);
  assert.equal(d.n, 10);
  assert.deepEqual(d.counts, { a: 5, b: 3, c: 2 });

  const majority = majorityBaseline(d);
  assert.equal(majority.label, "a");
  assert.equal(majority.correct, 5);
  close(majority.accuracy, 0.5);

  close(priorBrierLoss(d), 0.62);
});

test("the prior Brier equals one minus the sum of squared base rates", () => {
  for (const labels of [HAND, ["x", "y"], ["p", "p", "p", "q"], ["one"]]) {
    const d = distributionOf(labels);
    const gini = 1 - Object.values(d.shares).reduce((sum, p) => sum + p * p, 0);
    close(priorBrierLoss(d), gini);
  }
});

test("a one-label field has no floor to beat", () => {
  const d = distributionOf(["only", "only", "only"]);
  close(majorityBaseline(d).accuracy, 1);
  close(priorBrierLoss(d), 0);
  assert.equal(decisionScore(0, priorBrierLoss(d)), null);
  assert.equal(accuracyDecisionScore(1, 1), null);
});

test("a Decision Score is 100 at no loss, 0 at the prior, and negative below it", () => {
  close(decisionScore(0, 0.62) as number, 100);
  close(decisionScore(0.62, 0.62) as number, 0);
  close(decisionScore(0.93, 0.62) as number, -50);
  close(accuracyDecisionScore(1, 0.5) as number, 100);
  close(accuracyDecisionScore(0.5, 0.5) as number, 0);
  close(accuracyDecisionScore(0.75, 0.5) as number, 50);
  close(accuracyDecisionScore(0.25, 0.5) as number, -50);
});

test("label fields are read per shape: a scalar per case, an array or map per part", () => {
  const cases = [
    { expected: { verdict: "post", parts: [true, false], cover: { p1: "covered" } } },
    { expected: { verdict: "hold", parts: [true], cover: { p1: "covered", p2: "uncovered" } } },
  ];
  const { fields } = labelFields(cases);
  const by = (name: string) => fields.find((f) => f.name === name);

  assert.deepEqual(by("verdict")?.distribution.counts, { post: 1, hold: 1 });
  assert.equal(by("verdict")?.unit, "case");
  assert.deepEqual(by("parts[]")?.distribution.counts, { true: 2, false: 1 });
  assert.equal(by("parts[]")?.unit, "part");
  assert.deepEqual(by("cover{}")?.distribution.counts, { covered: 2, uncovered: 1 });
});

test("keys that differ only by an index are one question, pooled, and numbers are not labels", () => {
  const cases = [
    { expected: { part_0_done: true, part_1_done: false }, code_expectations: { claimed_parts: [0, 1] } },
    { expected: { part_0_done: true } },
  ];
  const { fields, skipped } = labelFields(cases);
  const pooled = fields.find((f) => f.name === "part_*_done");
  assert.deepEqual(pooled?.distribution.counts, { true: 2, false: 1 });
  assert.deepEqual(pooled?.pooledFrom, ["part_0_done", "part_1_done"]);
  assert.equal(skipped.find((s) => s.name === "claimed_parts")?.block, "code_expectations");
});
