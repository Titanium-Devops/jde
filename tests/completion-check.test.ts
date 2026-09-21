import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  completionCheck,
  completionQuestions,
  completionVerdict,
  filePartPasses,
  partQuestion,
  RESULT_IS_ECHO_QUESTION,
} from "../src/decisions/completion-check.ts";
import type { Receipts, TaskPart } from "../src/decisions/completion-check.ts";
import { codeJudge } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import type { Judge, PolicyBook, Questions } from "../src/types.ts";

const POLICY: PolicyBook = {
  "completion-check": {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "fall_back" },
    ],
    aggregate: "all_parts_at_least_0.7",
    on_error: "fall_back",
    timeout_ms: 750,
  },
};

const PARTS: readonly TaskPart[] = [
  { kind: "action", text: "search for the three libraries" },
  { kind: "file", text: "write the comparison", path: "docs/queue-options.md" },
  { kind: "reply", text: "name the recommended library" },
];

const RECEIPTS: Receipts = {
  tool_calls: [{ name: "webSearch", count: 5 }],
  files_written: [{ path: "docs/queue-options.md", bytes: 5120, first_line: "# options" }],
  searches: 5,
  pages_fetched: 4,
  transcript_entries: 18,
  elapsed_s: 420,
};

function run(answers: Record<string, number>, parts: readonly TaskPart[] = PARTS, receipts: Receipts = RECEIPTS, claimed?: readonly number[]) {
  return completionCheck(
    {
      task: "a task",
      task_parts: parts,
      claimed_result: "a claim",
      receipts,
      ...(claimed !== undefined ? { claimed_parts: claimed } : {}),
    },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers }), ledger: memoryLedger() },
  );
}

test("a file part is never asked of a model", () => {
  const questions = completionQuestions(PARTS);
  assert.deepEqual(Object.keys(questions), ["result_is_echo", "part_0_done", "part_2_done"]);
  assert.equal(questions.result_is_echo, RESULT_IS_ECHO_QUESTION);
});

test("a file part is the exact path, written, and not empty", () => {
  const part = { kind: "file", text: "write it", path: "docs/queue-options.md" } as const;
  assert.equal(filePartPasses(part, RECEIPTS), true);
  assert.equal(filePartPasses({ ...part, path: "docs/queue_options.md" }, RECEIPTS), false);
  assert.equal(filePartPasses(part, { files_written: [{ path: "docs/queue-options.md", bytes: 0 }] }), false);
  assert.equal(filePartPasses(part, {}), false);
});

test("a file part decides itself even when the judge says otherwise", async () => {
  const written = await run({ result_is_echo: 0.01, part_0_done: 0.96, part_2_done: 0.95 });
  assert.deepEqual(written.parts.map((part) => part.passes), [true, true, true]);
  assert.equal(written.parts[1]?.noul, undefined);
  assert.equal(written.parts[1]?.evidence, "file written");
  assert.equal(written.verdict, "done");

  const missing = await run(
    { result_is_echo: 0.01, part_0_done: 0.96, part_2_done: 0.95 },
    PARTS,
    { ...RECEIPTS, files_written: [] },
  );
  assert.equal(missing.parts[1]?.passes, false);
  assert.equal(missing.parts[1]?.evidence, "no such file");
  assert.equal(missing.verdict, "partial");
});

test("the verdict is what the parts add up to", () => {
  const outcome = (passes: boolean[]) => passes.map((p, index) => ({ index, kind: "action" as const, passes: p }));
  assert.equal(completionVerdict(outcome([true, true, true])), "done");
  assert.equal(completionVerdict(outcome([true, false, true])), "partial");
  assert.equal(completionVerdict(outcome([false, false, false])), "not_done");
});

test("a one part task is never partial", async () => {
  const one: readonly TaskPart[] = [{ kind: "reply", text: "recommend weekly or daily, with a reason" }];
  const done = await run({ result_is_echo: 0.02, part_0_done: 0.93 }, one, {});
  assert.equal(done.verdict, "done");
  const not = await run({ result_is_echo: 0.02, part_0_done: 0.11 }, one, {});
  assert.equal(not.verdict, "not_done");
});

test("a part below the floor did not happen, whatever the claim said", async () => {
  const outcome = await run({ result_is_echo: 0.02, part_0_done: 0.69, part_2_done: 0.95 });
  assert.equal(outcome.parts[0]?.passes, false);
  assert.equal(outcome.verdict, "partial");

  const atFloor = await run({ result_is_echo: 0.02, part_0_done: 0.7, part_2_done: 0.95 });
  assert.equal(atFloor.parts[0]?.passes, true);
  assert.equal(atFloor.verdict, "done");
});

test("an echo is reported beside the verdict, not folded into it", async () => {
  const outcome = await run({ result_is_echo: 0.93, part_0_done: 0.04, part_2_done: 0.03 }, PARTS, { files_written: [] });
  assert.deepEqual(outcome.result_is_echo, { value: true, noul: 0.93 });
  assert.equal(outcome.verdict, "not_done");

  const honest = await run({ result_is_echo: 0.05, part_0_done: 0.96, part_2_done: 0.94 });
  assert.equal(honest.result_is_echo?.value, false);
});

test("an overclaim is a named part the receipts do not carry", async () => {
  const outcome = await run({ result_is_echo: 0.02, part_0_done: 0.08, part_2_done: 0.95 }, PARTS, RECEIPTS, [0, 1, 2]);
  assert.deepEqual(outcome.overclaim, { parts: [0], any: true });

  const quiet = await run({ result_is_echo: 0.02, part_0_done: 0.55, part_2_done: 0.95 }, PARTS, RECEIPTS, [0, 2]);
  assert.deepEqual(quiet.overclaim, { parts: [], any: false }, "a part that is merely unproven is not an overclaim");

  const none = await run({ result_is_echo: 0.02, part_0_done: 0.95, part_2_done: 0.95 });
  assert.equal(none.overclaim, undefined);
});

test("a judge that does not answer leaves the verdict unmade", async () => {
  const outcome = await completionCheck(
    { task: "a task", task_parts: PARTS, claimed_result: "a claim", receipts: RECEIPTS },
    { policy: POLICY, judge: codeJudge({ fail: "http_error" }), ledger: memoryLedger() },
  );
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.action, "fall_back");
  assert.equal(outcome.result_is_echo, null);
  assert.deepEqual(outcome.parts, []);
  assert.equal(outcome.error?.reason, "http_error");
});

test("the state the judge sees is the four fields and no more", async () => {
  let seen: unknown;
  const spy: Judge = {
    id: "spy",
    async ask(state: unknown, questions: Questions) {
      seen = state;
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const id of Object.keys(questions)) answers[id] = { type: "noul", noul: 0.9 };
      return { answers };
    },
  };
  await completionCheck(
    { task: "a task", task_parts: PARTS, claimed_result: "a claim", receipts: RECEIPTS, claimed_parts: [0], context: { agentId: "a1" } },
    { policy: POLICY, judge: spy, ledger: memoryLedger() },
  );
  assert.deepEqual(Object.keys(seen as object), ["task", "task_parts", "claimed_result", "receipts"]);
});

test("the question wording is the measured wording", () => {
  assert.equal(
    partQuestion({ kind: "action", text: "search for the three libraries" }).instructions,
    "Do `receipts` show that this part was carried out: search for the three libraries? Count a file written, a search run, a page fetched, or a tool call that produces it; do not count `claimed_result` saying so.",
  );
  assert.equal(
    partQuestion({ kind: "reply", text: "name the recommended library" }).instructions,
    "Does `claimed_result` contain name the recommended library, stated as an outcome rather than a plan?",
  );
  assert.equal(
    RESULT_IS_ECHO_QUESTION.instructions,
    "Is `claimed_result` a restatement of `task` rather than a report of an outcome?",
  );
});
