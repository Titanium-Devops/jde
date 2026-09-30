import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ask } from "../src/index.ts";
import { RESULT_IS_ECHO_QUESTION, partQuestion } from "../src/decisions/completion-check.ts";
import { ADDS_REQUIREMENT_QUESTION, IS_PARROT_QUESTION, coverageQuestion } from "../src/decisions/task-restatement.ts";
import { ALREADY_TRIED_QUESTION } from "../src/decisions/ask-gate.ts";
import { aggregateFloor, bandFor, certaintyOf, confidenceOf, loadPolicyBook, policyFor } from "../src/policy.ts";
import { codeJudge, jevJudge, TYPESAFE_API_KEY_ENV } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import type { Band, LedgerRow, NoulQuestion, PolicyEntry, Questions } from "../src/types.ts";

/**
 * The rule these hold is that a band says how sure we are that something passed, and not how sure
 * the judge was of whatever it said.
 *
 * They are written against the policy that ships, read from `policy.json`, because the run that
 * found this wrote 88 rows answering false at 0.9 confidence or better under that exact file, and
 * every one of them carried an accepting action. Nothing below names an action as a string: which
 * actions accept is read off the policy's own bands and its own aggregate floor, so a policy that
 * renames its actions or moves its boundaries still gets tested for the rule rather than the
 * wording.
 */

const BOOK = loadPolicyBook();
const COMPLETION = policyFor("completion-check", BOOK);

/** The floor every question has to clear, named by the policy's own aggregate rule. */
function floorOf(entry: PolicyEntry): number {
  const floor = aggregateFloor(entry.aggregate);
  assert.ok(floor !== undefined, "this test wants a policy whose aggregate names its floor");
  return floor;
}

/** The actions a policy takes when it is satisfied: every band at or above its own floor. */
function acceptingActions(entry: PolicyEntry): ReadonlySet<string> {
  const floor = floorOf(entry);
  return new Set(entry.bands.filter((band: Band) => band.at_least >= floor).map((band) => band.action));
}

/** What the policy does when nothing clears: the bottom band, which every policy is made to have. */
function fallBackAction(entry: PolicyEntry): string {
  return bandFor(0, entry.bands).band.action;
}

const ACTION_PART = partQuestion({ kind: "action", text: "search for the three libraries" });

async function askOne(questions: Questions, answers: Record<string, number>) {
  const ledger = memoryLedger();
  const outcome = await ask(
    { decision: "completion-check", state: {}, questions },
    { policy: BOOK, judge: codeJudge({ id: "code-1", answers }), ledger },
  );
  return { outcome, rows: ledger.rows as readonly LedgerRow[] };
}

test("a confident false on a pass-is-true question never lands in an accepting band", async () => {
  // The defect, in one case. "Was part one done?" answered 0.04 is the judge saying no, clearly.
  const { outcome, rows } = await askOne({ part_1_done: ACTION_PART }, { part_1_done: 0.04 });
  const accepting = acceptingActions(COMPLETION);

  const row = rows.find((entry) => entry.question === "part_1_done") as LedgerRow;
  assert.equal(row.answer, "false");
  assert.equal(row.confidence, 0.04);
  assert.equal(accepting.has(row.action), false, "a part the judge says was not done was accepted");
  assert.equal(accepting.has(outcome.action), false);
  assert.equal(outcome.action, fallBackAction(COMPLETION));

  // The judge was sure. That is the number the old confidence reported, and it is still reachable
  // under its own name; what changed is that no band is read off it.
  assert.equal(outcome.certainty, 0.96);
});

test("a confident false on a pass-is-false question still bands as accepting", async () => {
  // The echo question. "Is the result just the task restated?" answered 0.04 is the good answer,
  // and flipping the polarity naively would have started failing this one when it succeeded.
  const { outcome, rows } = await askOne({ result_is_echo: RESULT_IS_ECHO_QUESTION }, { result_is_echo: 0.04 });
  const accepting = acceptingActions(COMPLETION);

  const row = rows.find((entry) => entry.question === "result_is_echo") as LedgerRow;
  assert.equal(row.answer, "false");
  assert.equal(row.confidence, 0.96);
  assert.equal(accepting.has(row.action), true);
  assert.equal(accepting.has(outcome.action), true);

  // And the other way: a result that really is an echo is not accepted, however sure the judge is.
  const echoed = await askOne({ result_is_echo: RESULT_IS_ECHO_QUESTION }, { result_is_echo: 0.96 });
  // A pass confidence for a question that passes on false is one minus the answer, so it carries
  // whatever float error that subtraction has. Bands compare, so the noise never reaches a band.
  assert.ok(Math.abs((echoed.outcome.confidence ?? 1) - 0.04) < 1e-9);
  assert.equal(acceptingActions(COMPLETION).has(echoed.outcome.action), false);
});

test("a decision whose every part failed falls back rather than accepting", async () => {
  const { outcome } = await askOne(
    { result_is_echo: RESULT_IS_ECHO_QUESTION, part_0_done: ACTION_PART, part_1_done: ACTION_PART },
    { result_is_echo: 0.02, part_0_done: 0.03, part_1_done: 0.05 },
  );
  assert.equal(outcome.action, fallBackAction(COMPLETION));
  assert.equal(acceptingActions(COMPLETION).has(outcome.action), false);
  // Every part failed and the judge was certain of all three, so certainty alone would have
  // accepted the lot. The two numbers are what tells those cases apart.
  assert.equal(outcome.certainty, 0.95);
});

test("no confidently failing answer anywhere in the range carries an accepting action", async () => {
  // The round trip. Sweep the whole range against both polarities and assert the banding, so the
  // 88 rows cannot come back one question at a time.
  const accepting = acceptingActions(COMPLETION);
  const floor = floorOf(COMPLETION);
  const cases: ReadonlyArray<readonly [string, NoulQuestion]> = [
    ["part_0_done", ACTION_PART],
    ["result_is_echo", RESULT_IS_ECHO_QUESTION],
  ];

  for (const [id, question] of cases) {
    const passesOnTrue = question.passingAnswer !== "false";
    for (let step = 0; step <= 100; step += 1) {
      const noul = step / 100;
      const { outcome, rows } = await askOne({ [id]: question }, { [id]: noul });
      const row = rows.find((entry) => entry.question === id) as LedgerRow;
      const passConfidence = passesOnTrue ? noul : 1 - noul;

      assert.equal(row.confidence, passConfidence, `${id} at ${noul}`);
      assert.equal(
        accepting.has(row.action),
        passConfidence >= floor,
        `${id} at ${noul}: accepted on a ${passConfidence} chance it passed`,
      );
      assert.equal(accepting.has(outcome.action), passConfidence >= floor, `${id} at ${noul}`);

      // The one the run made 88 of: the answer written down is a no, and the action taken is yes.
      if (row.answer === "false" && passesOnTrue) {
        assert.equal(accepting.has(row.action), false, `${id} at ${noul} answered false and accepted`);
      }
    }
  }
});

test("each noul question in the package says which answer passes, and is right about it", () => {
  // Every question that reaches a judge, audited one at a time rather than left to the default.
  assert.equal(RESULT_IS_ECHO_QUESTION.passingAnswer, "false");
  assert.equal(ADDS_REQUIREMENT_QUESTION.passingAnswer, "false");
  assert.equal(IS_PARROT_QUESTION.passingAnswer, "false");
  assert.equal(ALREADY_TRIED_QUESTION.passingAnswer, "either");
  assert.equal(ACTION_PART.passingAnswer, "true");
  assert.equal(partQuestion({ kind: "reply", text: "name one" }).passingAnswer, "true");
  assert.equal(coverageQuestion({ id: "p1", text: "write the file" }).passingAnswer, "true");
});

test("a question with no failing answer is confident when the judge was sure, either way", () => {
  // `already_tried` is a fact code branches on. A clear no is as useful as a clear yes, and only a
  // judge that could not say costs this question anything.
  assert.equal(confidenceOf({ type: "noul", noul: 0.02 }, ALREADY_TRIED_QUESTION), 0.98);
  assert.equal(confidenceOf({ type: "noul", noul: 0.98 }, ALREADY_TRIED_QUESTION), 0.98);
  assert.equal(confidenceOf({ type: "noul", noul: 0.5 }, ALREADY_TRIED_QUESTION), 0.5);
});

test("certainty is kept, beside the confidence, and is not what the action is read off", () => {
  assert.equal(certaintyOf({ type: "noul", noul: 0.04 }), 0.96);
  assert.equal(confidenceOf({ type: "noul", noul: 0.04 }, ACTION_PART), 0.04);
  assert.equal(confidenceOf({ type: "noul", noul: 0.04 }, RESULT_IS_ECHO_QUESTION), 0.96);
  // A choice or a score carries its own confidence, and neither is affected.
  assert.equal(confidenceOf({ type: "choice", choice: "runnable", confidence: 0.81 }), 0.81);
  assert.equal(certaintyOf({ type: "choice", choice: "runnable", confidence: 0.81 }), 0.81);
});

test("the judge is never told which answer passes", async () => {
  // `passingAnswer` names the answer we consider good, on questions asked to find out whether the
  // judge can tell. It reached the wire for one commit. This holds the request body to the three
  // fields a judge reasons from, so the next field added for code's use cannot follow it out.
  const sent: string[] = [];
  const questions: Questions = {
    result_is_echo: RESULT_IS_ECHO_QUESTION,
    part_0_done: ACTION_PART,
    adds_requirement: ADDS_REQUIREMENT_QUESTION,
    is_parrot: IS_PARROT_QUESTION,
    already_tried: ALREADY_TRIED_QUESTION,
  };

  const was = process.env[TYPESAFE_API_KEY_ENV];
  process.env[TYPESAFE_API_KEY_ENV] = "not-a-key";
  try {
    const judge = jevJudge({
      fetchImpl: async (_url, init) => {
        sent.push(String((init as RequestInit).body));
        return new Response(JSON.stringify({ answers: {}, model: "jev-test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await judge.ask({ task: "a task" }, questions, new AbortController().signal).catch(() => undefined);
  } finally {
    if (was === undefined) delete process.env[TYPESAFE_API_KEY_ENV];
    else process.env[TYPESAFE_API_KEY_ENV] = was;
  }

  assert.equal(sent.length, 1);
  const body = sent[0] as string;
  assert.equal(body.includes("passingAnswer"), false, "the answer key went to the judge");

  const parsed = JSON.parse(body) as { state: unknown; model: string; questions: Record<string, object> };
  assert.deepEqual(Object.keys(parsed).sort(), ["model", "questions", "state"]);
  for (const [id, question] of Object.entries(parsed.questions)) {
    assert.deepEqual(Object.keys(question).sort(), ["criteria", "instructions", "type"], id);
  }
  // Every question was still asked, and the criteria the judge reads are untouched.
  assert.deepEqual(Object.keys(parsed.questions).sort(), Object.keys(questions).sort());
  assert.deepEqual(
    (parsed.questions.result_is_echo as { criteria: unknown }).criteria,
    RESULT_IS_ECHO_QUESTION.criteria,
  );
});
