#!/usr/bin/env node
// Runs a decision against a case set through the real judge, and reports what it got right.
//
// The key is read from TYPESAFE_API_KEY, by the judge, and from nowhere else. It is never printed,
// never logged and never written to the output file. Every case in cases/ is synthetic.
//
// Usage: node scripts/eval.mjs
//          [--cases <path>]        default cases/completion-check-blind.json
//          [--out <path>]          default out/completion-check-eval.json
//          [--set <label>]         header label, default the case file's name
//          [--timeout-ms <n>]      the deadline for one judgment, default 30000
//          [--concurrency <n>]     default 4
//          [--attempts <n>]        whole-decision retries on a refusal, default 5
//          [--only <substring>]    run the cases whose id contains this
//
// A case file is a bare array or {cases: [...]}. Two label shapes are read, and converted here in
// code rather than by hand: the blind shape, {expected: {parts: [...], done, result_is_echo}}, and
// the tuned shape, {expected: {part_<i>_done, result_is_echo}, code_expectations: {done,
// claimed_parts}}. A label of "computed_by_code" is not graded.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completionCheck,
  COMPLETION_DECISION,
  jevJudge,
  nullLedger,
  partQuestionId,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CODE_OWNED = "computed_by_code";
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
const RETRYABLE = new Set(["http_error", "network", "timeout"]);
const BASE_BACKOFF_MS = 600;

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Export it in the shell that runs this script and try again.");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const casesPath = resolve(process.cwd(), flag("--cases", resolve(REPO, "cases/completion-check-blind.json")));
const outPath = resolve(process.cwd(), flag("--out", resolve(REPO, "out/completion-check-eval.json")));
const setLabel = flag("--set", casesPath.split("/").pop());
const timeoutMs = Number(flag("--timeout-ms", 30000));
const concurrency = Number(flag("--concurrency", 4));
const maxAttempts = Number(flag("--attempts", 5));
const only = flag("--only", undefined);

// The eval's own policy. The bands and the aggregate are the shipped ones; only the deadline moves,
// because 750 ms is the budget a live turn can spend waiting and not the budget a measurement has.
const POLICY = {
  [COMPLETION_DECISION]: {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "fall_back" },
    ],
    aggregate: "all_parts_at_least_0.7",
    on_error: "fall_back",
    timeout_ms: timeoutMs,
  },
};

const raw = JSON.parse(await readFile(casesPath, "utf8"));
const allCases = (Array.isArray(raw) ? raw : raw.cases).filter((c) => (only ? String(c.id).includes(only) : true));

/** Both label shapes, read into one. Nothing here is edited by hand. */
function labelsOf(testCase) {
  const parts = testCase.state.task_parts ?? [];
  const expected = testCase.expected ?? {};
  if (Array.isArray(expected.parts)) {
    return {
      parts: expected.parts,
      done: expected.done,
      echo: expected.result_is_echo,
      claimedParts: undefined,
    };
  }
  return {
    parts: parts.map((_part, i) => expected[partQuestionId(i)]),
    done: testCase.code_expectations?.done,
    echo: expected.result_is_echo,
    claimedParts: testCase.code_expectations?.claimed_parts,
  };
}

const judge = jevJudge();

async function runCase(testCase) {
  const labels = labelsOf(testCase);
  const input = {
    task: testCase.state.task,
    task_parts: testCase.state.task_parts,
    claimed_result: testCase.state.claimed_result,
    receipts: testCase.state.receipts,
    ...(labels.claimedParts === undefined ? {} : { claimed_parts: labels.claimedParts }),
  };

  let outcome;
  let attempts = 0;
  // The engine never retries a judgment; this retries the decision, which is the eval's business.
  while (attempts < maxAttempts) {
    attempts += 1;
    outcome = await completionCheck(input, { policy: POLICY, judge, ledger: nullLedger() });
    if (outcome.error === undefined || !RETRYABLE.has(outcome.error.reason)) break;
    if (attempts < maxAttempts) {
      await new Promise((done) => setTimeout(done, BASE_BACKOFF_MS * 2 ** (attempts - 1) + Math.floor(Math.random() * 250)));
    }
  }

  return { id: testCase.id, note: testCase.note, labels, outcome, attempts, ...grade(testCase, labels, outcome) };
}

/**
 * A part answered by a model is graded at the halfway line, which is what a noul means. The floor
 * of 0.7 is a policy about acting, not about being right, and the verdict is graded separately
 * with that floor applied.
 */
function grade(testCase, labels, outcome) {
  const parts = testCase.state.task_parts ?? [];
  const grades = [];
  if (outcome.error !== undefined) {
    return { grades, verdict: { labelled: labels.done, computed: null, correct: false, scored: labels.done !== undefined && labels.done !== CODE_OWNED } };
  }

  parts.forEach((part, i) => {
    const label = labels.parts?.[i];
    if (label === undefined || label === CODE_OWNED) return;
    const outcomePart = outcome.parts[i];
    if (part.kind === "file") {
      grades.push({ question: partQuestionId(i), kind: "file", by: "code", expected: label, got: outcomePart.passes, correct: outcomePart.passes === label, confidence: null });
      return;
    }
    const noul = outcomePart.noul ?? 0;
    const got = noul >= 0.5;
    grades.push({ question: partQuestionId(i), kind: part.kind, by: "judge", expected: label, got, raw: noul, correct: got === label, confidence: Math.max(noul, 1 - noul) });
  });

  if (labels.echo !== undefined && labels.echo !== CODE_OWNED) {
    const noul = outcome.result_is_echo?.noul ?? 0;
    const got = noul >= 0.5;
    grades.push({ question: "result_is_echo", kind: "echo", by: "judge", expected: labels.echo, got, raw: noul, correct: got === labels.echo, confidence: Math.max(noul, 1 - noul) });
  }

  const scored = labels.done !== undefined && labels.done !== CODE_OWNED;
  return {
    grades,
    verdict: { labelled: labels.done, computed: outcome.verdict, correct: scored ? outcome.verdict === labels.done : null, scored },
  };
}

async function inPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const at = next++;
        if (at >= items.length) return;
        results[at] = await worker(items[at]);
      }
    }),
  );
  return results;
}

const startedAt = Date.now();
const records = await inPool(allCases, concurrency, runCase);
const wallMs = Date.now() - startedAt;

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const pct = (correct, total) => (total === 0 ? "n/a" : `${((correct / total) * 100).toFixed(1)}%`);
const pad = (text, width) => String(text).padEnd(width);
const padLeft = (text, width) => String(text).padStart(width);

const allGrades = records.flatMap((record) => record.grades);
const slice = (test) => {
  const rows = allGrades.filter(test);
  return { rows, correct: rows.filter((row) => row.correct).length };
};

const fileParts = slice((g) => g.kind === "file");
const actionParts = slice((g) => g.kind === "action");
const replyParts = slice((g) => g.kind === "reply");
const judgedParts = slice((g) => g.by === "judge" && g.kind !== "echo");
const echo = slice((g) => g.kind === "echo");
const everyPart = slice((g) => g.kind !== "echo");

const scoredVerdicts = records.filter((record) => record.verdict.scored);
const verdictsCorrect = scoredVerdicts.filter((record) => record.verdict.correct).length;
const failed = records.filter((record) => record.outcome.error !== undefined);

const BUCKETS = [
  { label: "below 0.50", lo: 0, hi: 0.5 },
  { label: "0.50 to 0.70", lo: 0.5, hi: 0.7 },
  { label: "0.70 to 0.90", lo: 0.7, hi: 0.9 },
  { label: "0.90 to 1.00", lo: 0.9, hi: 1.0000001 },
];

const latencies = records.filter((r) => r.outcome.error === undefined).map((r) => r.outcome.latencyMs).sort((a, b) => a - b);
const percentile = (p) => (latencies.length === 0 ? 0 : latencies[Math.min(Math.max(Math.ceil(p * latencies.length), 1), latencies.length) - 1]);
const inputTokens = records.reduce((total, r) => total + (r.outcome.usage?.inputTokens ?? 0), 0);
const models = [...new Set(records.map((r) => r.outcome.judge))];

const lines = [];
lines.push(`JDE eval, ${COMPLETION_DECISION}, ${setLabel}`);
lines.push(`${records.length} cases, ${allGrades.length} graded questions, answered by ${models.join(", ")}`);
lines.push("");
lines.push("accuracy by question");
lines.push(`  file parts, decided in code    ${padLeft(pct(fileParts.correct, fileParts.rows.length), 7)}  (${fileParts.correct} of ${fileParts.rows.length})`);
lines.push(`  action parts, noul vs receipts ${padLeft(pct(actionParts.correct, actionParts.rows.length), 7)}  (${actionParts.correct} of ${actionParts.rows.length})`);
lines.push(`  reply parts, noul vs claim     ${padLeft(pct(replyParts.correct, replyParts.rows.length), 7)}  (${replyParts.correct} of ${replyParts.rows.length})`);
lines.push(`  every part the judge answered  ${padLeft(pct(judgedParts.correct, judgedParts.rows.length), 7)}  (${judgedParts.correct} of ${judgedParts.rows.length})`);
lines.push(`  every part, code and judge     ${padLeft(pct(everyPart.correct, everyPart.rows.length), 7)}  (${everyPart.correct} of ${everyPart.rows.length})`);
lines.push(`  result_is_echo                 ${padLeft(pct(echo.correct, echo.rows.length), 7)}  (${echo.correct} of ${echo.rows.length})`);
lines.push("");
lines.push("accuracy by verdict, aggregated in code");
lines.push(`  done, partial or not_done      ${padLeft(pct(verdictsCorrect, scoredVerdicts.length), 7)}  (${verdictsCorrect} of ${scoredVerdicts.length})`);
for (const verdict of ["done", "partial", "not_done"]) {
  const rows = scoredVerdicts.filter((record) => record.verdict.labelled === verdict);
  const right = rows.filter((record) => record.verdict.correct).length;
  lines.push(`    labelled ${pad(verdict, 21)} ${padLeft(pct(right, rows.length), 7)}  (${right} of ${rows.length})`);
}
for (const record of scoredVerdicts.filter((r) => !r.verdict.correct)) {
  const shown = record.outcome.parts.map((p) => (p.kind === "file" ? `file:${p.passes ? "pass" : "fail"}` : `${p.kind}:${(p.noul ?? 0).toFixed(2)}`)).join(" ");
  lines.push(`    ${pad(record.id, 20)} labelled ${pad(record.verdict.labelled, 10)} computed ${pad(record.verdict.computed, 10)} ${shown}`);
}
lines.push("");
lines.push("accuracy by confidence, over every question the judge answered");
for (const bucket of BUCKETS) {
  const rows = allGrades.filter((g) => g.confidence !== null && g.confidence >= bucket.lo && g.confidence < bucket.hi);
  const right = rows.filter((row) => row.correct).length;
  lines.push(`  ${pad(bucket.label, 30)} ${padLeft(pct(right, rows.length), 7)}  (${right} of ${rows.length})`);
}
lines.push("");
for (const grade of allGrades.filter((g) => !g.correct)) {
  const record = records.find((r) => r.grades.includes(grade));
  lines.push(`  wrong: ${pad(record.id, 20)} ${pad(grade.question, 14)} expected ${pad(grade.expected, 6)} got ${pad(grade.got, 6)} ${grade.raw === undefined ? "" : `noul ${grade.raw.toFixed(2)}`}`);
}
if (failed.length > 0) {
  for (const record of failed) lines.push(`  no answer: ${pad(record.id, 20)} ${record.outcome.error.reason} after ${record.attempts} attempt(s)`);
}
lines.push("");
lines.push(`latency p50 ${percentile(0.5)}ms, p95 ${percentile(0.95)}ms, wall ${(wallMs / 1000).toFixed(1)}s at concurrency ${concurrency}`);
lines.push(`input tokens ${inputTokens}, about $${((inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS).toFixed(4)} at $${USD_PER_MILLION_INPUT_TOKENS} per million`);

const report = lines.join("\n");
console.log(report);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  JSON.stringify(
    {
      decision: COMPLETION_DECISION,
      set: setLabel,
      cases_path: casesPath,
      models,
      timeout_ms: timeoutMs,
      ran_at: new Date().toISOString(),
      report,
      records,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\nraw output written to ${outPath}`);
