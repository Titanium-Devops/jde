import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ask, AGGREGATE_ROW } from "../src/index.ts";
import { codeJudge, jevJudge } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import type { Judge, LedgerRow, PolicyBook, Questions } from "../src/types.ts";

const POLICY: PolicyBook = {
  "test-decision": {
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

const QUESTIONS: Questions = {
  first: { type: "noul", instructions: "Does it hold?", criteria: { true: "it holds", false: "it does not" } },
  second: { type: "noul", instructions: "Does the other hold?", criteria: { true: "it holds", false: "it does not" } },
};

function rowsOf(ledger: ReturnType<typeof memoryLedger>): LedgerRow[] {
  return ledger.rows.filter((row): row is LedgerRow => "question" in row);
}

test("one row per question, then the decision's own row", async () => {
  const ledger = memoryLedger();
  const outcome = await ask(
    { decision: "test-decision", state: { anything: true }, questions: QUESTIONS, context: { agentId: "a1", turnId: "t7" } },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers: { first: 0.94, second: 0.91 } }), ledger },
  );

  const rows = rowsOf(ledger);
  assert.deepEqual(rows.map((row) => row.question), ["first", "second", AGGREGATE_ROW]);
  assert.equal(outcome.decisions.length, 3);
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.band, "90plus");
  assert.equal(outcome.confidence, 0.91);
});

test("a ledger row carries the decision and never the state", async () => {
  const ledger = memoryLedger();
  await ask(
    { decision: "test-decision", state: { secret_request: "a customer sentence" }, questions: QUESTIONS, context: { agentId: "a1", turnId: "t7" } },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers: { first: 0.94, second: 0.2 } }), ledger },
  );

  const first = rowsOf(ledger)[0] as LedgerRow;
  assert.deepEqual(Object.keys(first).sort(), [
    "action", "agentId", "answer", "band", "confidence", "decision", "id", "judge", "latencyMs", "question", "ts", "turnId",
  ]);
  assert.equal(first.decision, "test-decision");
  assert.equal(first.question, "first");
  assert.equal(first.answer, "true");
  assert.equal(first.confidence, 0.94);
  assert.equal(first.band, "90plus");
  assert.equal(first.action, "accept");
  assert.equal(first.judge, "code-1");
  assert.equal(first.agentId, "a1");
  assert.equal(first.turnId, "t7");
  assert.ok(typeof first.latencyMs === "number");
  assert.ok(!JSON.stringify(ledger.rows).includes("a customer sentence"));
});

test("the aggregate is the weakest answer, and one weak answer drops the action", async () => {
  const ledger = memoryLedger();
  const outcome = await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    { policy: POLICY, judge: codeJudge({ answers: { first: 0.99, second: 0.75 } }), ledger },
  );
  assert.equal(outcome.confidence, 0.75);
  assert.equal(outcome.action, "accept_with_note");

  const perQuestion = rowsOf(ledger).filter((row) => row.question !== AGGREGATE_ROW);
  assert.deepEqual(perQuestion.map((row) => row.action), ["accept", "accept_with_note"]);
});

test("a judge that misses the deadline falls back and never throws", async () => {
  const ledger = memoryLedger();
  const outcome = await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    {
      policy: { "test-decision": { ...POLICY["test-decision"]!, timeout_ms: 20 } },
      judge: codeJudge({ delayMs: 400, answers: { first: 0.99, second: 0.99 } }),
      ledger,
    },
  );

  assert.equal(outcome.action, "fall_back");
  assert.equal(outcome.error?.reason, "timeout");
  assert.deepEqual(outcome.answers, {});
  assert.equal(outcome.confidence, null);
  assert.equal(outcome.band, null);

  const rows = rowsOf(ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.question, AGGREGATE_ROW);
  assert.equal(rows[0]?.error, "timeout");
  assert.equal(rows[0]?.action, "fall_back");
});

test("a refusal, a missing key and an unreadable answer all fall back", async () => {
  for (const reason of ["http_error", "no_key", "network"] as const) {
    const outcome = await ask(
      { decision: "test-decision", state: {}, questions: QUESTIONS },
      { policy: POLICY, judge: codeJudge({ fail: reason }), ledger: memoryLedger() },
    );
    assert.equal(outcome.action, "fall_back");
    assert.equal(outcome.error?.reason, reason);
  }

  const missing = await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    { policy: POLICY, judge: codeJudge({ answers: { first: 0.9 } }), ledger: memoryLedger() },
  );
  assert.equal(missing.action, "fall_back");
  assert.equal(missing.error?.reason, "malformed");

  const wrongType = await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    {
      policy: POLICY,
      judge: codeJudge({ raw: { first: { type: "choice", choice: "yes", confidence: 1 }, second: { type: "noul", noul: 1 } } }),
      ledger: memoryLedger(),
    },
  );
  assert.equal(wrongType.action, "fall_back");
  assert.equal(wrongType.error?.reason, "malformed");
});

test("the judge sees the state, the questions and a deadline, and nothing else", async () => {
  let seen: { state: unknown; questions: Questions; args: number } | undefined;
  const spy: Judge = {
    id: "spy",
    async ask(state, questions, signal) {
      seen = { state, questions, args: arguments.length };
      assert.ok(signal instanceof AbortSignal);
      return { answers: { first: { type: "noul", noul: 0.95 }, second: { type: "noul", noul: 0.95 } } };
    },
  };

  await ask(
    { decision: "test-decision", state: { a: 1 }, questions: QUESTIONS, context: { agentId: "a1", turnId: "t7" } },
    { policy: POLICY, judge: spy, ledger: memoryLedger() },
  );

  assert.equal(seen?.args, 3);
  assert.deepEqual(seen?.state, { a: 1 });
  assert.deepEqual(Object.keys(seen?.questions ?? {}), ["first", "second"]);
  const serialised = JSON.stringify(seen);
  assert.ok(!serialised.includes("a1"), "the context never reaches the judge");
  assert.ok(!serialised.includes("all_parts_at_least"), "the aggregate rule never reaches the judge");
  assert.ok(!serialised.includes("accept"), "the bands never reach the judge");
});

test("the key reaches the request and nothing else", async () => {
  const sentinel = "sk-fake-for-this-test-only-8e21";
  const before = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = sentinel;
  let authorization: string | undefined;

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { first: { type: "noul", noul: 0.97 }, second: { type: "noul", noul: 0.96 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const ledger = memoryLedger();
  try {
    const outcome = await ask(
      { decision: "test-decision", state: { task: "x" }, questions: QUESTIONS },
      { policy: POLICY, judge: jevJudge({ fetchImpl }), ledger },
    );
    assert.equal(outcome.judge, "jev-1.13.0", "the model that answered is what the rows record");
    assert.equal(outcome.action, "accept");
  } finally {
    if (before === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = before;
  }

  assert.equal(authorization, `Bearer ${sentinel}`);
  assert.ok(!JSON.stringify(ledger.rows).includes(sentinel), "no row carries the key");
  assert.ok(!JSON.stringify(ledger.rows).includes("sk-"), "no row carries anything key shaped");
});

test("a call with no questions, or a decision with no policy, is a programming error", async () => {
  await assert.rejects(
    () => ask({ decision: "test-decision", state: {}, questions: {} }, { policy: POLICY, ledger: memoryLedger() }),
    /no questions/,
  );
  await assert.rejects(
    () => ask({ decision: "nothing-here", state: {}, questions: QUESTIONS }, { policy: POLICY, ledger: memoryLedger() }),
    /no policy entry/,
  );
});
