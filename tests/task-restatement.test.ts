import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ADDS_REQUIREMENT_ID,
  ADDS_REQUIREMENT_QUESTION,
  casePartId,
  coverageQuestion,
  coverageQuestionId,
  fromExtractedParts,
  isBottomBand,
  IS_PARROT_ID,
  IS_PARROT_QUESTION,
  normaliseParts,
  partIndexOf,
  ratioSaysParrot,
  restatementQuestions,
  restatementVerdict,
  similarityRatio,
  taskRestatement,
} from "../src/decisions/task-restatement.ts";
import type { RestatementPart } from "../src/decisions/task-restatement.ts";
import { extractTaskParts } from "../src/parts.ts";
import { codeJudge } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import type { PolicyBook } from "../src/types.ts";

const POLICY: PolicyBook = {
  "task-restatement": {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "escalate" },
    ],
    aggregate: "all_parts_at_least_0.7",
    on_error: "proceed",
    timeout_ms: 750,
  },
};

const TASK =
  "Research the three managed Postgres providers, write the comparison to notes/pg-pricing.md, and tell me which to pick.";

const RESTATEMENT =
  "You want me to look at three hosted Postgres options, put a side by side table in notes/pg-pricing.md, and finish by naming the one I would go with.";

const PARTS: readonly RestatementPart[] = [
  { id: "p1", kind: "action", text: "research the three managed Postgres providers" },
  { id: "p2", kind: "file", text: "write the comparison", path: "notes/pg-pricing.md" },
  { id: "p3", kind: "reply", text: "state which to pick" },
];

const COVERED = { part_p1_covered: 0.96, part_p2_covered: 0.94, part_p3_covered: 0.95 };
const CLEAN = { ...COVERED, [ADDS_REQUIREMENT_ID]: 0.03, [IS_PARROT_ID]: 0.04 };

function run(
  answers: Record<string, number>,
  extra: { parts?: unknown; task?: string; restatement?: string; loop?: number } = {},
) {
  return taskRestatement(
    {
      task: extra.task ?? TASK,
      taskParts: extra.parts === undefined ? PARTS : extra.parts,
      restatement: extra.restatement ?? RESTATEMENT,
      ...(extra.loop === undefined ? {} : { loop: extra.loop }),
    },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers }), ledger: memoryLedger() },
  );
}

// ---------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------

test("one question per part, then the two about the whole restatement", () => {
  const questions = restatementQuestions(PARTS, true);
  assert.deepEqual(Object.keys(questions), [
    "part_p1_covered",
    "part_p2_covered",
    "part_p3_covered",
    ADDS_REQUIREMENT_ID,
    IS_PARROT_ID,
  ]);
  assert.equal(questions[ADDS_REQUIREMENT_ID], ADDS_REQUIREMENT_QUESTION);
  assert.equal(questions[IS_PARROT_ID], IS_PARROT_QUESTION);
});

test("a coverage question names its own part, and a file part carries its path", () => {
  const action = coverageQuestion(PARTS[0] as RestatementPart);
  assert.match(action.instructions, /research the three managed Postgres providers\?$/);
  assert.equal(action.type, "noul");
  const file = coverageQuestion(PARTS[1] as RestatementPart);
  assert.match(file.instructions, /\(at notes\/pg-pricing\.md\)/);
  const already = coverageQuestion({ id: "p1", kind: "file", text: "write it to a/b.md", path: "a/b.md" });
  assert.equal(already.instructions.includes("(at a/b.md)"), false);
});

// ---------------------------------------------------------------------------
// The similarity pre-screen, which is code's and not a question.
// ---------------------------------------------------------------------------

test("the similarity ratio is 1 on a copy and low on a paraphrase", () => {
  assert.equal(similarityRatio(TASK, TASK), 1);
  assert.equal(ratioSaysParrot(similarityRatio(TASK, TASK)), true);
  assert.ok(similarityRatio(TASK, RESTATEMENT) < 0.2);
  assert.equal(ratioSaysParrot(similarityRatio(TASK, RESTATEMENT)), false);
});

test("a near verbatim copy is settled by the ratio and a paraphrase is not", () => {
  const nearly = "Research the three managed Postgres providers, write the comparison to notes/pg-pricing.md, and say which to pick.";
  const reordered = "Write the comparison to notes/pg-pricing.md, research the three managed Postgres providers, and tell me which to pick.";
  const keepsTheNouns = "I will compare the three managed Postgres providers on price, record what I find in notes/pg-pricing.md, and end with a recommendation.";
  assert.equal(ratioSaysParrot(similarityRatio(TASK, nearly)), true);
  assert.equal(ratioSaysParrot(similarityRatio(TASK, reordered)), true);
  assert.equal(ratioSaysParrot(similarityRatio(TASK, keepsTheNouns)), false);
  assert.ok(similarityRatio(TASK, keepsTheNouns) < 0.25);
});

test("an empty or one word restatement has a ratio of nothing", () => {
  assert.equal(similarityRatio(TASK, "Postgres."), 0);
  assert.equal(similarityRatio(TASK, ""), 0);
  assert.equal(similarityRatio("", RESTATEMENT), 0);
});

test("the ratio reads short strings with short runs", () => {
  assert.equal(similarityRatio("ship it", "ship it"), 1);
  assert.equal(similarityRatio("ship it", "hold it"), 0);
});

test("a copy the ratio settles is never asked of a model", async () => {
  const outcome = await run(CLEAN, { restatement: TASK });
  assert.equal(outcome.parrot?.by, "code");
  assert.equal(outcome.parrot?.value, true);
  assert.equal(outcome.parrot?.noul, null);
  assert.equal(outcome.similarity, 1);
  assert.equal(IS_PARROT_ID in outcome.answers, false);
  assert.equal(outcome.verdict, "escalate");
});

// ---------------------------------------------------------------------------
// The bands.
// ---------------------------------------------------------------------------

test("accept: every part covered, nothing added, not a copy", async () => {
  const outcome = await run(CLEAN);
  assert.equal(outcome.verdict, "accept");
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.band, "90plus");
  assert.deepEqual(outcome.uncovered, []);
  assert.equal(outcome.addedRequirement?.value, false);
  assert.equal(outcome.parrot?.by, "judge");
  assert.equal(outcome.parts.length, 3);
});

test("revise: a part the restatement did not carry, named by id", async () => {
  const outcome = await run({ ...CLEAN, part_p2_covered: 0.04 });
  assert.equal(outcome.verdict, "revise");
  assert.deepEqual(outcome.uncovered, ["p2"]);
  assert.equal(outcome.parts[1]?.covered, false);
});

test("revise: a requirement the request did not contain", async () => {
  const outcome = await run({ ...CLEAN, [ADDS_REQUIREMENT_ID]: 0.93 });
  assert.equal(outcome.verdict, "revise");
  assert.deepEqual(outcome.uncovered, []);
  assert.equal(outcome.addedRequirement?.value, true);
});

test("escalate: the judge says it is a copy", async () => {
  const outcome = await run({ ...CLEAN, [IS_PARROT_ID]: 0.93 });
  assert.equal(outcome.verdict, "escalate");
  assert.equal(outcome.parrot?.by, "judge");
  assert.equal(outcome.parrot?.value, true);
});

test("escalate: an answer in the bottom band, even with nothing else wrong", async () => {
  const outcome = await run({ ...CLEAN, [ADDS_REQUIREMENT_ID]: 0.4 });
  assert.equal(outcome.band, "0to70");
  assert.equal(isBottomBand(outcome.band), true);
  assert.equal(outcome.addedRequirement?.value, false);
  assert.equal(outcome.verdict, "escalate");
  assert.equal(outcome.action, "escalate");
});

test("escalate: a revise the loop budget has run out of", async () => {
  const uncovered = { ...CLEAN, part_p2_covered: 0.04 };
  assert.equal((await run(uncovered, { loop: 1 })).verdict, "revise");
  assert.equal((await run(uncovered, { loop: 2 })).verdict, "escalate");
});

test("the middle band accepts with a note while the verdict stays accept", async () => {
  const outcome = await run({ ...CLEAN, part_p1_covered: 0.8 });
  assert.equal(outcome.band, "70to90");
  assert.equal(outcome.action, "accept_with_note");
  assert.equal(outcome.verdict, "accept");
});

test("the verdict is code's, over answers the judge gave one at a time", () => {
  const covered = [{ id: "p1", index: 0, text: "x", covered: true, noul: 0.9 }];
  const missed = [{ id: "p1", index: 0, text: "x", covered: false, noul: 0.1 }];
  const base = { addedRequirement: false, parrot: false, bottomBand: false, loop: 0 };
  assert.equal(restatementVerdict({ ...base, parts: covered }), "accept");
  assert.equal(restatementVerdict({ ...base, parts: missed }), "revise");
  assert.equal(restatementVerdict({ ...base, parts: covered, addedRequirement: true }), "revise");
  assert.equal(restatementVerdict({ ...base, parts: covered, parrot: true }), "escalate");
  assert.equal(restatementVerdict({ ...base, parts: covered, bottomBand: true }), "escalate");
  assert.equal(restatementVerdict({ ...base, parts: missed, loop: 2 }), "escalate");
});

test("the bottom band is read off the policy's own label, with no threshold in code", () => {
  assert.equal(isBottomBand("0to70"), true);
  assert.equal(isBottomBand("0plus"), true);
  assert.equal(isBottomBand("70to90"), false);
  assert.equal(isBottomBand("90plus"), false);
  assert.equal(isBottomBand(null), false);
});

// ---------------------------------------------------------------------------
// A judge that does not answer.
// ---------------------------------------------------------------------------

test("a timeout proceeds, unjudged, and changes nothing", async () => {
  const outcome = await taskRestatement(
    { task: TASK, taskParts: PARTS, restatement: RESTATEMENT },
    {
      policy: { "task-restatement": { ...POLICY["task-restatement"]!, timeout_ms: 5 } },
      judge: codeJudge({ delayMs: 50, answers: CLEAN }),
      ledger: memoryLedger(),
    },
  );
  assert.equal(outcome.error?.reason, "timeout");
  assert.equal(outcome.action, "proceed");
  assert.equal(outcome.verdict, null);
  assert.deepEqual(outcome.parts, []);
  assert.equal(outcome.parrot, null);
  assert.equal(outcome.addedRequirement, null);
  assert.equal(outcome.decisions.length, 1);
  assert.equal(outcome.decisions[0]?.error, "timeout");
});

test("a judge error proceeds the same way", async () => {
  const outcome = await taskRestatement(
    { task: TASK, taskParts: PARTS, restatement: RESTATEMENT },
    { policy: POLICY, judge: codeJudge({ fail: "http_error" }), ledger: memoryLedger() },
  );
  assert.equal(outcome.error?.reason, "http_error");
  assert.equal(outcome.action, "proceed");
  assert.equal(outcome.verdict, null);
});

test("an answer that never came back is a fallback, not a partial decision", async () => {
  const outcome = await run({ part_p1_covered: 0.9 });
  assert.equal(outcome.error?.reason, "malformed");
  assert.equal(outcome.action, "proceed");
  assert.equal(outcome.verdict, null);
});

// ---------------------------------------------------------------------------
// One part, and the part ids.
// ---------------------------------------------------------------------------

test("a one part task asks one coverage question", async () => {
  const one = [{ id: "p1", kind: "reply", text: "recommend a provider" }];
  const covered = await run({ part_p1_covered: 0.95, [ADDS_REQUIREMENT_ID]: 0.02, [IS_PARROT_ID]: 0.03 }, { parts: one });
  assert.equal(covered.parts.length, 1);
  assert.equal(covered.verdict, "accept");
  const missed = await run({ part_p1_covered: 0.05, [ADDS_REQUIREMENT_ID]: 0.02, [IS_PARROT_ID]: 0.03 }, { parts: one });
  assert.equal(missed.verdict, "revise");
  assert.deepEqual(missed.uncovered, ["p1"]);
});

test("the extractor numbers from zero and the case sets number from one", () => {
  const extracted = extractTaskParts(TASK);
  assert.deepEqual(extracted.map((part) => part.id), ["part_0", "part_1", "part_2"]);
  const mapped = fromExtractedParts(extracted);
  assert.deepEqual(mapped.map((part) => part.id), ["p1", "p2", "p3"]);
  assert.deepEqual(mapped.map((part) => part.kind), ["action", "file", "reply"]);
  assert.equal(mapped[1]?.path, "notes/pg-pricing.md");
  assert.equal(casePartId(0), "p1");
  assert.equal(partIndexOf("p1"), 0);
  assert.equal(partIndexOf("part_0"), 0);
  assert.equal(partIndexOf("p12"), 11);
  assert.equal(partIndexOf("whatever"), -1);
  assert.equal(coverageQuestionId(casePartId(1)), "part_p2_covered");
});

test("a task with no parts given is read by the extractor, keyed p1 up", async () => {
  const outcome = await run(CLEAN, { parts: undefined });
  assert.deepEqual(outcome.parts.map((part) => part.id), ["p1", "p2", "p3"]);
  assert.equal(outcome.verdict, "accept");
});

test("parts are read in whatever shape they were written", () => {
  assert.deepEqual(normaliseParts(["research it", "write it"]), [
    { id: "p1", text: "research it" },
    { id: "p2", text: "write it" },
  ]);
  assert.deepEqual(normaliseParts([{ text: "research it" }]), [{ id: "p1", text: "research it" }]);
  assert.deepEqual(normaliseParts([{ id: "a", text: "research it" }]), [{ id: "a", text: "research it" }]);
  assert.deepEqual(normaliseParts({ p2: "write it" }), [{ id: "p2", text: "write it" }]);
  assert.deepEqual(normaliseParts([{ kind: "file", text: "write it", path: "a.md" }]), [
    { id: "p1", text: "write it", kind: "file", path: "a.md" },
  ]);
  assert.throws(() => normaliseParts([{ kind: "action" }]), /no text/);
});

test("a check with no parts at all is a programming error, not a judgment", async () => {
  await assert.rejects(
    () => taskRestatement({ task: TASK, taskParts: [], restatement: RESTATEMENT }, { policy: POLICY, judge: codeJudge(), ledger: memoryLedger() }),
    /at least one task part/,
  );
});

test("every question and the decision itself reach the ledger", async () => {
  const ledger = memoryLedger();
  await taskRestatement(
    { task: TASK, taskParts: PARTS, restatement: RESTATEMENT, context: { agentId: "a1", turnId: "t1" } },
    { policy: POLICY, judge: codeJudge({ answers: CLEAN }), ledger },
  );
  assert.deepEqual(ledger.rows.map((row) => (row as { question: string }).question), [
    "part_p1_covered",
    "part_p2_covered",
    "part_p3_covered",
    ADDS_REQUIREMENT_ID,
    IS_PARROT_ID,
    "aggregate",
  ]);
  assert.equal(ledger.rows.every((row) => (row as { decision: string }).decision === "task-restatement"), true);
  assert.equal((ledger.rows[0] as { agentId: string }).agentId, "a1");
});
