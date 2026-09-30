import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "../src/index.ts";
import { codeJudge } from "../src/judge/index.ts";
import { fileLedger, markReviewed, markRight, markWrong, memoryLedger, readLedger, taggedLedger } from "../src/ledger.ts";
import {
  calibrate,
  calibrateLedger,
  classifyEntries,
  describeCalibration,
  joinReviews,
  resolveReviews,
} from "../src/review.ts";
import type { LedgerRow, PolicyBook, Questions, ReviewMarker } from "../src/types.ts";

function row(id: string, confidence: number, extra: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id,
    ts: "2026-09-21T00:00:00.000Z",
    decision: "completion-check",
    question: "aggregate",
    answer: "true",
    confidence,
    band: "90plus",
    action: "accept",
    judge: "jev-1.13.0",
    latencyMs: 180,
    ...extra,
  };
}

function marker(id: string, wrong: boolean, ts: string, by = "jason"): ReviewMarker {
  return { id, wrong, by, ts };
}

test("a row nobody reviewed is not a correct row", () => {
  const join = joinReviews([row("a", 0.95), row("b", 0.95), marker("a", false, "2026-09-21T01:00:00.000Z")]);
  assert.equal(join.reviewed.length, 1);
  assert.equal(join.unreviewed.length, 1);
  assert.equal(join.unreviewed[0]?.id, "b");

  const calibration = calibrate(join.reviewed);
  assert.equal(calibration.reviewed, 1, "the denominator is reviewed rows, not every row");
  assert.equal(calibration.wrong, 0);
  assert.equal(calibration.pooledError, 0);

  // The unreviewed row must not quietly improve the picture: with it counted as right, a single
  // wrong review would read as 50 percent rather than 100.
  const withWrong = calibrate(
    joinReviews([row("a", 0.95), row("b", 0.95), marker("a", true, "2026-09-21T01:00:00.000Z")]).reviewed,
  );
  assert.equal(withWrong.reviewed, 1);
  assert.equal(withWrong.pooledError, 1);
});

test("right and wrong land on opposite sides", () => {
  const join = joinReviews([
    row("a", 0.95),
    row("b", 0.95),
    marker("a", false, "2026-09-21T01:00:00.000Z"),
    marker("b", true, "2026-09-21T01:00:00.000Z"),
  ]);
  const calibration = calibrate(join.reviewed);
  assert.equal(calibration.reviewed, 2);
  assert.equal(calibration.wrong, 1);
  assert.equal(calibration.pooledError, 0.5);

  const top = calibration.bins[9];
  assert.equal(top?.reviewed, 2);
  assert.equal(top?.wrong, 1);
  assert.equal(top?.error, 0.5);
});

test("two markers on one row: the most recent wins, and both stay in the file", () => {
  const entries = [
    row("a", 0.95),
    marker("a", true, "2026-09-21T01:00:00.000Z"),
    marker("a", false, "2026-09-21T02:00:00.000Z", "kelley"),
  ];
  const join = joinReviews(entries);
  assert.equal(join.reviewed.length, 1);
  assert.equal(join.reviewed[0]?.review.wrong, false, "last one wins");
  assert.equal(join.reviewed[0]?.review.by, "kelley");
  assert.equal(join.reviewed[0]?.all.length, 2, "the earlier verdict is not deleted");
  assert.equal(join.contradicted, 1);
  assert.equal(calibrate(join.reviewed).pooledError, 0);

  const reversed = joinReviews([
    row("a", 0.95),
    marker("a", false, "2026-09-21T02:00:00.000Z"),
    marker("a", true, "2026-09-21T01:00:00.000Z"),
  ]);
  assert.equal(reversed.reviewed[0]?.review.wrong, false, "the newest timestamp wins, not the last line");
});

test("markers with the same timestamp resolve by the order they were appended", () => {
  const same = "2026-09-21T01:00:00.000Z";
  const { latest } = resolveReviews([marker("a", true, same, "first"), marker("a", false, same, "second")]);
  assert.equal(latest.get("a")?.by, "second");
});

test("a marker pointing at no row is counted, not joined", () => {
  const join = joinReviews([row("a", 0.95), marker("ghost", true, "2026-09-21T01:00:00.000Z")]);
  assert.equal(join.reviewed.length, 0);
  assert.equal(join.dangling.length, 1);
  assert.equal(calibrate(join.reviewed).pooledError, null);
});

test("a reviewed fallback row is held out of the bins", () => {
  const join = joinReviews([
    row("a", 0, { error: "timeout", answer: "none", action: "fall_back" }),
    marker("a", true, "2026-09-21T01:00:00.000Z"),
  ]);
  assert.equal(join.reviewed.length, 0);
  assert.equal(join.reviewedErrorRows.length, 1);
});

test("a confidence lands in its own bin, and 1.0 lands in the top one", () => {
  const entries = [0.05, 0.35, 0.9, 1].flatMap((confidence, index) => [
    row(`r${index}`, confidence),
    marker(`r${index}`, false, "2026-09-21T01:00:00.000Z"),
  ]);
  const bins = calibrate(joinReviews(entries).reviewed).bins;
  assert.equal(bins.length, 10);
  assert.equal(bins[0]?.reviewed, 1);
  assert.equal(bins[3]?.reviewed, 1);
  assert.equal(bins[9]?.reviewed, 2, "0.9 and 1.0 are both in the last bin");
  assert.equal(bins[5]?.reviewed, 0);
  assert.equal(bins[5]?.error, null, "an empty bin has no error rate, which is not the same as zero");
});

test("no threshold without enough reviewed judgments, and it says so in words", () => {
  const entries = Array.from({ length: 40 }, (_unused, index) => [
    row(`r${index}`, 0.98),
    marker(`r${index}`, false, "2026-09-21T01:00:00.000Z"),
  ]).flat();
  const calibration = calibrate(joinReviews(entries).reviewed);
  assert.equal(calibration.pooledError, 0, "every one of them was right");
  assert.equal(calibration.threshold, null, "and forty of them still set nothing");
  assert.match(calibration.shortfall ?? "", /40 reviewed judgments, and a threshold needs at least 100/);
  assert.match(describeCalibration(joinReviews(entries), calibration), /no threshold can be set/);
});

test("an empty ledger says there is no denominator, not that everything is fine", () => {
  const calibration = calibrate([]);
  assert.equal(calibration.reviewed, 0);
  assert.equal(calibration.pooledError, null);
  assert.equal(calibration.threshold, null);
  assert.match(calibration.shortfall ?? "", /no judgment in this ledger has been reviewed/);
});

test("the threshold is the smallest confidence that clears the bar with the reviews to back it", () => {
  const entries: unknown[] = [];
  const add = (id: string, confidence: number, wrong: boolean) => {
    entries.push(row(id, confidence), marker(id, wrong, "2026-09-21T01:00:00.000Z"));
  };
  // 120 judgments at 0.95, 3 of them wrong: 2.5 percent, over the minimum.
  for (let i = 0; i < 120; i += 1) add(`high${i}`, 0.95, i < 3);
  // 60 at 0.75, half of them wrong, which drags any pool that includes them over 5 percent.
  for (let i = 0; i < 60; i += 1) add(`mid${i}`, 0.75, i % 2 === 0);

  // 0.8 is the smallest edge whose pool leaves the bad ones out: 120 reviewed, 3 wrong.
  const calibration = calibrate(joinReviews(entries).reviewed);
  assert.equal(calibration.threshold?.confidence, 0.8);
  assert.equal(calibration.threshold?.reviewed, 120);
  assert.equal(calibration.threshold?.pooledError, 3 / 120);

  const bin7 = calibration.bins[7];
  assert.equal(bin7?.reviewed, 60, "the 0.75 judgments are in the 0.7 to 0.8 bin");
  assert.equal(bin7?.error, 0.5);

  // Pooling from 0.7 down takes in the bad ones: 33 wrong of 180, which is 18 percent, so no edge
  // below 0.8 clears the bar however far the minimum count is dropped.
  const smallPoolsAllowed = calibrate(joinReviews(entries).reviewed, { minReviewed: 1 });
  assert.equal(smallPoolsAllowed.threshold?.confidence, 0.8, "a smaller pool does not make a worse one acceptable");
});

test("a reviewer's verdict reaches the file, and the row it points at is untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jde-review-"));
  const path = join(dir, "ledger.jsonl");
  const ledger = fileLedger(path);
  const policy: PolicyBook = {
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
  const questions: Questions = {
    only: { type: "noul", instructions: "Does it hold?", criteria: { true: "it holds", false: "it does not" } },
  };

  const outcome = await ask(
    { decision: "test-decision", state: {}, questions },
    { policy, judge: codeJudge({ answers: { only: 0.96 } }), ledger },
  );
  const judged = outcome.decisions[0] as LedgerRow;
  await markRight(ledger, judged.id, "jason", { why: "the file really was written" });

  const entries = await readLedger(path);
  const { rows, markers, unreadable } = classifyEntries(entries);
  assert.equal(rows.length, 2);
  assert.equal(markers.length, 1);
  assert.equal(unreadable, 0);
  assert.equal(markers[0]?.wrong, false);
  assert.equal(markers[0]?.why, "the file really was written");
  assert.deepEqual(rows[0], judged, "the judgment row is exactly as it was written");

  const { join: joined, calibration } = await calibrateLedger(path, { question: "only" });
  assert.equal(joined.reviewed.length, 1);
  assert.equal(calibration.pooledError, 0);
  assert.equal(calibration.threshold, null);
});

test("markWrong writes what it always wrote, and an old marker still joins", async () => {
  const ledger = memoryLedger();
  const written = await markWrong(ledger, "row-1", "jason", { now: () => new Date("2026-09-21T03:00:00.000Z") });
  assert.deepEqual(written, { id: "row-1", wrong: true, by: "jason", ts: "2026-09-21T03:00:00.000Z" });
  assert.deepEqual(ledger.rows, [written]);

  // A marker written before reviewed-and-right existed carries no `why` and is still a review.
  const join = joinReviews([row("row-1", 0.93), { id: "row-1", wrong: true, by: "jason", ts: "2026-09-20T00:00:00.000Z" }]);
  assert.equal(join.reviewed.length, 1);
  assert.equal(calibrate(join.reviewed).pooledError, 1);
});

test("markReviewed carries either verdict and an optional line of why", async () => {
  const ledger = memoryLedger();
  await markReviewed(ledger, "row-1", { wrong: true, by: "kelley" }, { why: "the scan said nothing of the kind" });
  await markReviewed(ledger, "row-2", { wrong: false, by: "kelley" });
  const [first, second] = ledger.rows as ReviewMarker[];
  assert.equal(first?.wrong, true);
  assert.equal(first?.why, "the scan said nothing of the kind");
  assert.equal(second?.wrong, false);
  assert.equal("why" in (second ?? {}), false, "no empty why on a marker that has none");
});

test("a line that is neither a judgment nor a review is counted, not guessed at", () => {
  const { unreadable } = classifyEntries([row("a", 0.9), { something: "else" }, 7, null]);
  assert.equal(unreadable, 3);
});

test("filtering by decision and question narrows what is calibrated", () => {
  const entries = [
    row("a", 0.95, { decision: "completion-check", question: "aggregate" }),
    row("b", 0.95, { decision: "task-restatement", question: "aggregate" }),
    row("c", 0.95, { decision: "completion-check", question: "part_0_done" }),
    marker("a", true, "2026-09-21T01:00:00.000Z"),
    marker("b", false, "2026-09-21T01:00:00.000Z"),
    marker("c", false, "2026-09-21T01:00:00.000Z"),
  ];
  assert.equal(joinReviews(entries, { decision: "completion-check" }).reviewed.length, 2);
  assert.equal(joinReviews(entries, { question: "aggregate" }).reviewed.length, 2);
  assert.equal(joinReviews(entries, { decision: "completion-check", question: "aggregate" }).reviewed.length, 1);
});

test("the sink stamps a run, so a harness cannot write an untagged judgment", async () => {
  const inner = memoryLedger();
  const tagged = taggedLedger(inner, { runKind: "eval", runId: "completion-check:blind:2026-09-21" });
  await tagged.append(row("a", 0.95));
  await tagged.append(marker("a", false, "2026-09-21T01:00:00.000Z"));

  const [judgment, verdict] = inner.rows as [LedgerRow, ReviewMarker];
  assert.equal(judgment.runKind, "eval");
  assert.equal(judgment.runId, "completion-check:blind:2026-09-21");
  assert.equal("runKind" in verdict, false, "a person's verdict belongs to them, not to the run");
});

test("a threshold is never set on eval traffic by accident", () => {
  const entries = [
    row("live", 0.95),
    row("harness", 0.95, { runKind: "eval", runId: "r1" }),
    marker("live", true, "2026-09-21T01:00:00.000Z"),
    marker("harness", false, "2026-09-21T01:00:00.000Z"),
  ];

  const live = joinReviews(entries);
  assert.equal(live.reviewed.length, 1);
  assert.equal(live.reviewed[0]?.row.id, "live");
  assert.equal(live.otherTraffic.rows, 1, "the eval row is left out and counted");
  assert.equal(calibrate(live.reviewed).pooledError, 1);

  const harness = joinReviews(entries, { include: "eval" });
  assert.equal(harness.reviewed.length, 1);
  assert.equal(harness.reviewed[0]?.row.id, "harness");
  assert.equal(calibrate(harness.reviewed).pooledError, 0);

  const both = joinReviews(entries, { include: "all" });
  assert.equal(both.reviewed.length, 2);
  assert.equal(both.otherTraffic.rows, 0);

  assert.match(describeCalibration(live, calibrate(live.reviewed)), /1 eval row\(s\) left out/);
});

test("one run can be pulled out of a shared file", () => {
  const entries = [
    row("a", 0.95, { runKind: "eval", runId: "r1" }),
    row("b", 0.95, { runKind: "eval", runId: "r2" }),
    marker("a", false, "2026-09-21T01:00:00.000Z"),
    marker("b", true, "2026-09-21T01:00:00.000Z"),
  ];
  const first = joinReviews(entries, { include: "eval", runId: "r1" });
  assert.equal(first.reviewed.length, 1);
  assert.equal(first.reviewed[0]?.row.id, "a");
});

test("a run tag reaches the row through the context as well as the sink", async () => {
  const ledger = memoryLedger();
  const policy: PolicyBook = {
    "test-decision": {
      bands: [{ at_least: 0, action: "fall_back" }],
      aggregate: "min_confidence",
      on_error: "fall_back",
      timeout_ms: 750,
    },
  };
  const questions: Questions = {
    only: { type: "noul", instructions: "Does it hold?", criteria: { true: "it holds", false: "it does not" } },
  };
  await ask(
    { decision: "test-decision", state: {}, questions, context: { turnId: "case-7", runKind: "eval", runId: "r9" } },
    { policy, judge: codeJudge({ answers: { only: 0.96 } }), ledger },
  );
  const first = ledger.rows[0] as LedgerRow;
  assert.equal(first.runKind, "eval");
  assert.equal(first.runId, "r9");
  assert.equal(first.turnId, "case-7");
});
