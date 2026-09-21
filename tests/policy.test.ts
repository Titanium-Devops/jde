import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bandFor, confidenceOf, answerText, resolveAggregate, validatePolicyEntry } from "../src/policy.ts";
import type { Band, PolicyEntry } from "../src/types.ts";

const BANDS: readonly Band[] = [
  { at_least: 0.9, action: "accept" },
  { at_least: 0.7, action: "accept_with_note" },
  { at_least: 0, action: "fall_back" },
];

const ENTRY: PolicyEntry = {
  bands: BANDS,
  aggregate: "all_parts_at_least_0.7",
  on_error: "fall_back",
  timeout_ms: 750,
};

test("a confidence lands in the highest band it clears", () => {
  assert.equal(bandFor(1, BANDS).band.action, "accept");
  assert.equal(bandFor(0.9, BANDS).band.action, "accept");
  assert.equal(bandFor(0.8999, BANDS).band.action, "accept_with_note");
  assert.equal(bandFor(0.7, BANDS).band.action, "accept_with_note");
  assert.equal(bandFor(0.6999, BANDS).band.action, "fall_back");
  assert.equal(bandFor(0, BANDS).band.action, "fall_back");
});

test("a band label is read off the band's own boundaries", () => {
  assert.equal(bandFor(0.94, BANDS).label, "90plus");
  assert.equal(bandFor(0.72, BANDS).label, "70to90");
  assert.equal(bandFor(0.2, BANDS).label, "0to70");
});

test("bands out of order still band correctly", () => {
  const shuffled: readonly Band[] = [
    { at_least: 0, action: "fall_back" },
    { at_least: 0.9, action: "accept" },
    { at_least: 0.7, action: "accept_with_note" },
  ];
  assert.equal(bandFor(0.95, shuffled).band.action, "accept");
  assert.equal(bandFor(0.75, shuffled).band.action, "accept_with_note");
  assert.equal(bandFor(0.1, shuffled).band.action, "fall_back");
});

test("a policy without a bottom band is refused", () => {
  assert.throws(
    () => validatePolicyEntry("d", { ...ENTRY, bands: [{ at_least: 0.5, action: "accept" }] }),
    /no band at 0/,
  );
});

test("a policy without a fallback or a deadline is refused", () => {
  assert.throws(() => validatePolicyEntry("d", { ...ENTRY, on_error: "" }), /on_error/);
  assert.throws(() => validatePolicyEntry("d", { ...ENTRY, timeout_ms: 0 }), /timeout_ms/);
});

test("a policy naming an aggregate rule this build lacks is refused", () => {
  assert.throws(() => validatePolicyEntry("d", { ...ENTRY, aggregate: "vibes" }), /aggregate rule/);
  assert.ok(resolveAggregate("min_confidence"));
  assert.ok(resolveAggregate("mean_confidence"));
  assert.ok(resolveAggregate("all_parts_at_least_0.7"));
  assert.equal(resolveAggregate("all_parts_at_least_4"), undefined);
});

test("a noul's confidence is its distance from the middle", () => {
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }), 0.98);
  assert.equal(confidenceOf({ type: "noul", noul: 0.98 }), 0.98);
  assert.equal(confidenceOf({ type: "noul", noul: 0.5 }), 0.5);
  assert.equal(confidenceOf({ type: "choice", choice: "done", confidence: 0.81 }), 0.81);
});

test("the ledger records an answer, not a distribution", () => {
  assert.equal(answerText({ type: "noul", noul: 0.98 }), "true");
  assert.equal(answerText({ type: "noul", noul: 0.02 }), "false");
  assert.equal(answerText({ type: "choice", choice: "partial", confidence: 0.6 }), "partial");
});

test("min_confidence is the lowest answer, mean_confidence the average", () => {
  const answers = {
    a: { type: "noul", noul: 0.95 } as const,
    b: { type: "noul", noul: 0.2 } as const,
  };
  assert.equal(resolveAggregate("min_confidence")?.(answers), 0.8);
  assert.equal(resolveAggregate("mean_confidence")?.(answers), 0.875);
  assert.equal(resolveAggregate("all_parts_at_least_0.7")?.(answers), 0.8);
});
