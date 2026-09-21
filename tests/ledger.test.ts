import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "../src/index.ts";
import { codeJudge } from "../src/judge/index.ts";
import { fileLedger, markWrong, memoryLedger, nullLedger, readLedger } from "../src/ledger.ts";
import type { LedgerRow, PolicyBook, Questions, WrongMarker } from "../src/types.ts";

const POLICY: PolicyBook = {
  "test-decision": {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0, action: "fall_back" },
    ],
    aggregate: "min_confidence",
    on_error: "fall_back",
    timeout_ms: 750,
  },
};

const QUESTIONS: Questions = {
  only: { type: "noul", instructions: "Does it hold?", criteria: { true: "it holds", false: "it does not" } },
};

test("a decision appends lines to a file, and a correction appends beside them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jde-ledger-"));
  const path = join(dir, "nested", "ledger.jsonl");
  const ledger = fileLedger(path);

  const outcome = await ask(
    { decision: "test-decision", state: { anything: 1 }, questions: QUESTIONS, context: { agentId: "a1", turnId: "t7" } },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers: { only: 0.95 } }), ledger },
  );

  const first = outcome.decisions[0] as LedgerRow;
  await markWrong(ledger, first.id, "jason");

  const rows = (await readLedger(path)) as (LedgerRow | WrongMarker)[];
  assert.equal(rows.length, 3);
  assert.equal((rows[0] as LedgerRow).question, "only");
  assert.equal((rows[1] as LedgerRow).question, "aggregate");

  const marker = rows[2] as WrongMarker;
  assert.equal(marker.wrong, true);
  assert.equal(marker.id, first.id);
  assert.equal(marker.by, "jason");
  assert.ok(Date.parse(marker.ts) > 0);

  const original = rows[0] as LedgerRow;
  assert.equal(original.id, first.id, "the marked row is untouched");
  assert.equal(original.action, "accept");

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a ledger that cannot be written is never the reason a decision fails", async () => {
  const outcome = await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    { policy: POLICY, judge: codeJudge({ answers: { only: 0.95 } }), ledger: fileLedger("/proc/definitely/not/writable.jsonl") },
  );
  assert.equal(outcome.action, "accept");
  assert.equal(outcome.decisions.length, 2);
});

test("reading a ledger that is not there gives nothing, not an error", async () => {
  assert.deepEqual(await readLedger(join(tmpdir(), "jde-does-not-exist", "ledger.jsonl")), []);
});

test("the null ledger records nothing and the memory ledger records in order", async () => {
  const quiet = nullLedger();
  await quiet.append({ id: "x", wrong: true, by: "jason", ts: new Date().toISOString() });

  const ledger = memoryLedger();
  await ask(
    { decision: "test-decision", state: {}, questions: QUESTIONS },
    { policy: POLICY, judge: codeJudge({ answers: { only: 0.1 } }), ledger },
  );
  assert.deepEqual(ledger.rows.map((row) => ("question" in row ? row.question : "wrong")), ["only", "aggregate"]);
  // A noul of 0.1 is a confident false, so the row is a false in the top band, not a weak true.
  assert.equal((ledger.rows[0] as LedgerRow).answer, "false");
  assert.equal((ledger.rows[0] as LedgerRow).band, "90plus");
  assert.equal((ledger.rows[0] as LedgerRow).confidence, 0.9);
});
