import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  answerText,
  bandFor,
  certaintyOf,
  confidenceOf,
  passingAnswerOf,
  resolveAggregate,
  validatePolicyEntry,
} from "../src/policy.ts";
import type { Band, NoulQuestion, PolicyEntry } from "../src/types.ts";

const QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Does it hold?",
  criteria: { true: "it holds", false: "it does not" },
};

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

test("a noul's confidence is the probability of the answer that passes", () => {
  // This test used to assert the distance from the middle, and that is the defect it was holding
  // in place: 0.02 read as 0.98 confident, which banded a flat no as a confident yes.
  const holds: NoulQuestion = { ...QUESTION, passingAnswer: "true" };
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }, holds), 0.02);
  assert.equal(confidenceOf({ type: "noul", noul: 0.98 }, holds), 0.98);
  assert.equal(confidenceOf({ type: "noul", noul: 0.5 }, holds), 0.5);

  // A question that passes on false is one minus the answer, and carries that subtraction's float
  // error with it. Bands compare rather than match, so the noise never changes a band.
  const breaks: NoulQuestion = { ...QUESTION, passingAnswer: "false" };
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }, breaks), 0.98);
  assert.ok(Math.abs(confidenceOf({ type: "noul", noul: 0.98 }, breaks) - 0.02) < 1e-9);

  // A question with no failing answer, and a choice, both carry how sure the judge was.
  const either: NoulQuestion = { ...QUESTION, passingAnswer: "either" };
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }, either), 0.98);
  assert.equal(confidenceOf({ type: "choice", choice: "done", confidence: 0.81 }), 0.81);

  // A question left out reads as passing on true, which is what most of them do.
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }), 0.02);
});

test("certainty is how sure the judge was, whichever way it answered", () => {
  assert.equal(certaintyOf({ type: "noul", noul: 0.02 }), 0.98);
  assert.equal(certaintyOf({ type: "noul", noul: 0.98 }), 0.98);
  assert.equal(certaintyOf({ type: "noul", noul: 0.5 }), 0.5);
  assert.equal(certaintyOf({ type: "choice", choice: "done", confidence: 0.81 }), 0.81);
});

test("a question says which answer passes, and a noul question that does not passes on true", () => {
  assert.equal(passingAnswerOf(QUESTION), "true");
  assert.equal(passingAnswerOf({ ...QUESTION, passingAnswer: "false" }), "false");
  assert.equal(passingAnswerOf({ ...QUESTION, passingAnswer: "either" }), "either");
  assert.equal(passingAnswerOf(undefined), "true");
  assert.equal(passingAnswerOf({ type: "choice", instructions: "which?", criteria: { a: "a" } }), "true");
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
  // Nothing says which answer passes, so both read as passing on true: 0.2 is the weak one.
  assert.equal(resolveAggregate("min_confidence")?.(answers), 0.2);
  assert.equal(resolveAggregate("mean_confidence")?.(answers), 0.575);
  assert.equal(resolveAggregate("all_parts_at_least_0.7")?.(answers), 0.2);
});

test("an aggregate scores each answer however it is told to, and the rule does not know", () => {
  const answers = {
    a: { type: "noul", noul: 0.95 } as const,
    b: { type: "noul", noul: 0.2 } as const,
  };
  // The same answers, the same rule, scored by how sure the judge was rather than by what passed.
  // This is the pair `ask()` computes: one for the bands, one for callers who escalate a judge
  // that did not know. 0.2 is a confident no, so the certainty of the set is 0.8.
  assert.equal(resolveAggregate("min_confidence")?.(answers, certaintyOf), 0.8);
  assert.equal(resolveAggregate("mean_confidence")?.(answers, certaintyOf), 0.875);
});
