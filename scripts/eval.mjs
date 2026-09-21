#!/usr/bin/env node
// Runs a decision against a case set through the real judge, and reports what it got right.
//
// The key is read from TYPESAFE_API_KEY, by the judge, and from nowhere else. It is never printed,
// never logged and never written to the output file. Every case in cases/ is synthetic.
//
// Usage: node scripts/eval.mjs
//          [--decision <name>]     completion-check (default) or task-restatement
//          [--cases <path>]        default cases/<decision>-blind.json
//          [--out <path>]          default out/<decision>-eval.json
//          [--set <label>]         header label, default the case file's name
//          [--timeout-ms <n>]      the deadline for one judgment, default 30000
//          [--concurrency <n>]     default 4
//          [--attempts <n>]        whole-decision retries on a refusal, default 5
//          [--only <substring>]    run the cases whose id contains this
//          [--endpoint <url>]      a stand in for the judge, so the harness itself can be tested
//                                  offline before a blind set is spent on it
//
// A case file is a bare array or {cases: [...]}. Every label shape a case set uses is converted
// here in code rather than by hand, because a blind set is written before this script knows what
// it will look like and must never be edited to fit a harness.
//
// completion-check reads two: the blind shape, {expected: {parts: [...], done, result_is_echo}},
// and the tuned shape, {expected: {part_<i>_done, result_is_echo}, code_expectations: {done,
// claimed_parts}}. task-restatement reads {expected: {verdict, parts: {p1: "covered"|...},
// addedRequirement, parrot}}, with parts as an object keyed by part id or as an array in order.
// A label of "computed_by_code" is not graded.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completionCheck,
  COMPLETION_DECISION,
  isBottomBand,
  jevJudge,
  normaliseParts,
  nullLedger,
  partQuestionId,
  RESTATEMENT_DECISION,
  taskRestatement,
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

const decision = flag("--decision", COMPLETION_DECISION);
const casesPath = resolve(process.cwd(), flag("--cases", resolve(REPO, `cases/${decision}-blind.json`)));
const outPath = resolve(process.cwd(), flag("--out", resolve(REPO, `out/${decision}-eval.json`)));
const setLabel = flag("--set", casesPath.split("/").pop());
const timeoutMs = Number(flag("--timeout-ms", 30000));
const concurrency = Number(flag("--concurrency", 4));
const maxAttempts = Number(flag("--attempts", 5));
const only = flag("--only", undefined);
const endpoint = flag("--endpoint", undefined);

const judge = jevJudge(endpoint === undefined ? {} : { endpoint });

// ---------------------------------------------------------------------------
// completion-check: did the agent do the work.
// ---------------------------------------------------------------------------

// The eval's own policy. The bands and the aggregate are the shipped ones; only the deadline moves,
// because 750 ms is the budget a live turn can spend waiting and not the budget a measurement has.
const COMPLETION_POLICY = {
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

/** Both completion-check label shapes, read into one. Nothing here is edited by hand. */
function completionLabels(testCase) {
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

function completionInput(testCase, labels) {
  return {
    task: testCase.state.task,
    task_parts: testCase.state.task_parts,
    claimed_result: testCase.state.claimed_result,
    receipts: testCase.state.receipts,
    ...(labels.claimedParts === undefined ? {} : { claimed_parts: labels.claimedParts }),
  };
}

/**
 * A part answered by a model is graded at the halfway line, which is what a noul means. The floor
 * of 0.7 is a policy about acting, not about being right, and the verdict is graded separately
 * with that floor applied.
 */
function completionGrade(testCase, labels, outcome) {
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

function completionQuestionLines(allGrades, push) {
  const fileParts = slice(allGrades, (g) => g.kind === "file");
  const actionParts = slice(allGrades, (g) => g.kind === "action");
  const replyParts = slice(allGrades, (g) => g.kind === "reply");
  const judgedParts = slice(allGrades, (g) => g.by === "judge" && g.kind !== "echo");
  const everyPart = slice(allGrades, (g) => g.kind !== "echo");
  const echo = slice(allGrades, (g) => g.kind === "echo");
  push(`  file parts, decided in code    ${padLeft(pct(fileParts.correct, fileParts.rows.length), 7)}  (${fileParts.correct} of ${fileParts.rows.length})`);
  push(`  action parts, noul vs receipts ${padLeft(pct(actionParts.correct, actionParts.rows.length), 7)}  (${actionParts.correct} of ${actionParts.rows.length})`);
  push(`  reply parts, noul vs claim     ${padLeft(pct(replyParts.correct, replyParts.rows.length), 7)}  (${replyParts.correct} of ${replyParts.rows.length})`);
  push(`  every part the judge answered  ${padLeft(pct(judgedParts.correct, judgedParts.rows.length), 7)}  (${judgedParts.correct} of ${judgedParts.rows.length})`);
  push(`  every part, code and judge     ${padLeft(pct(everyPart.correct, everyPart.rows.length), 7)}  (${everyPart.correct} of ${everyPart.rows.length})`);
  push(`  result_is_echo                 ${padLeft(pct(echo.correct, echo.rows.length), 7)}  (${echo.correct} of ${echo.rows.length})`);
}

function completionVerdictLine(record) {
  return record.outcome.parts
    .map((p) => (p.kind === "file" ? `file:${p.passes ? "pass" : "fail"}` : `${p.kind}:${(p.noul ?? 0).toFixed(2)}`))
    .join(" ");
}

// ---------------------------------------------------------------------------
// task-restatement: did the bot read the request.
// ---------------------------------------------------------------------------

const RESTATEMENT_POLICY = {
  [RESTATEMENT_DECISION]: {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "escalate" },
    ],
    aggregate: "all_parts_at_least_0.7",
    on_error: "proceed",
    timeout_ms: timeoutMs,
  },
};

/** "covered" and "uncovered", or true and false, or a label code owns. */
function asBool(value) {
  if (value === true || value === "covered" || value === "yes" || value === "true") return true;
  if (value === false || value === "uncovered" || value === "no" || value === "false") return false;
  return undefined;
}

function restatementParts(testCase) {
  const given = testCase.state.taskParts ?? testCase.state.task_parts;
  return given === undefined || given === null ? undefined : normaliseParts(given);
}

/**
 * Coverage labels keyed by part id, whether the set wrote them as an object or as an array in
 * order, and whether or not it gave the parts at all. Keying by id rather than by position is what
 * lets a case that leaves `taskParts` out, and has them read off the task instead, still be graded.
 */
function restatementLabels(testCase) {
  const expected = testCase.expected ?? {};
  const parts = restatementParts(testCase);
  const given = expected.parts ?? expected.coverage ?? {};
  const byId = {};
  if (Array.isArray(given)) {
    given.forEach((value, i) => {
      byId[parts?.[i]?.id ?? `p${i + 1}`] = asBool(value);
    });
  } else {
    for (const [key, value] of Object.entries(given)) byId[key] = asBool(value);
  }
  return {
    parts: byId,
    added: asBool(expected.addedRequirement ?? expected.added_requirement),
    parrot: asBool(expected.parrot),
    verdict: expected.verdict,
  };
}

function restatementInput(testCase) {
  const parts = restatementParts(testCase);
  return {
    task: testCase.state.task,
    ...(parts === undefined ? {} : { taskParts: parts }),
    restatement: testCase.state.restatement,
  };
}

/**
 * Graded the same way the completion check grades: a question a model answered is graded at the
 * halfway line, which is what a noul means, and the verdict is graded with the policy's floors
 * applied because that is what code would actually have done.
 */
function restatementGrade(testCase, labels, outcome) {
  const grades = [];
  const scored = labels.verdict !== undefined && labels.verdict !== CODE_OWNED;
  if (outcome.error !== undefined) {
    return { grades, verdict: { labelled: labels.verdict, computed: null, correct: false, scored } };
  }

  outcome.parts.forEach((part, i) => {
    const label = labels.parts?.[part.id] ?? labels.parts?.[`p${i + 1}`];
    if (label === undefined) return;
    const got = part.noul >= 0.5;
    grades.push({ question: `part_${part.id}_covered`, kind: "coverage", by: "judge", expected: label, got, raw: part.noul, correct: got === label, confidence: Math.max(part.noul, 1 - part.noul) });
  });

  if (labels.added !== undefined) {
    const noul = outcome.addedRequirement?.noul ?? 0;
    const got = noul >= 0.5;
    grades.push({ question: "adds_requirement", kind: "added", by: "judge", expected: labels.added, got, raw: noul, correct: got === labels.added, confidence: Math.max(noul, 1 - noul) });
  }

  if (labels.parrot !== undefined) {
    const byCode = outcome.parrot?.by === "code";
    const noul = outcome.parrot?.noul ?? 0;
    const got = byCode ? outcome.parrot.value : noul >= 0.5;
    grades.push({
      question: "is_parrot",
      kind: "parrot",
      by: byCode ? "code" : "judge",
      expected: labels.parrot,
      got,
      ...(byCode ? { ratio: outcome.similarity } : { raw: noul }),
      correct: got === labels.parrot,
      confidence: byCode ? null : Math.max(noul, 1 - noul),
    });
  }

  return {
    grades,
    verdict: { labelled: labels.verdict, computed: outcome.verdict, correct: scored ? outcome.verdict === labels.verdict : null, scored },
  };
}

function restatementQuestionLines(allGrades, push) {
  const coverage = slice(allGrades, (g) => g.kind === "coverage");
  const added = slice(allGrades, (g) => g.kind === "added");
  const parrot = slice(allGrades, (g) => g.kind === "parrot");
  const byRatio = slice(allGrades, (g) => g.kind === "parrot" && g.by === "code");
  const byJudge = slice(allGrades, (g) => g.kind === "parrot" && g.by === "judge");
  const everything = slice(allGrades, () => true);
  push(`  coverage, one per task part    ${padLeft(pct(coverage.correct, coverage.rows.length), 7)}  (${coverage.correct} of ${coverage.rows.length})`);
  push(`  adds_requirement               ${padLeft(pct(added.correct, added.rows.length), 7)}  (${added.correct} of ${added.rows.length})`);
  push(`  is_parrot, code and judge      ${padLeft(pct(parrot.correct, parrot.rows.length), 7)}  (${parrot.correct} of ${parrot.rows.length})`);
  push(`    settled by the ratio alone   ${padLeft(pct(byRatio.correct, byRatio.rows.length), 7)}  (${byRatio.correct} of ${byRatio.rows.length})`);
  push(`    asked of the judge           ${padLeft(pct(byJudge.correct, byJudge.rows.length), 7)}  (${byJudge.correct} of ${byJudge.rows.length})`);
  push(`  every question                 ${padLeft(pct(everything.correct, everything.rows.length), 7)}  (${everything.correct} of ${everything.rows.length})`);
}

/** Which rule in code produced this verdict. Reported, never fed back into the decision. */
function restatementReason(outcome) {
  if (outcome.error !== undefined) return `unjudged: ${outcome.error.reason}`;
  if (outcome.parrot?.value) return `parrot by ${outcome.parrot.by} (ratio ${outcome.similarity.toFixed(2)})`;
  if (isBottomBand(outcome.band)) return `bottom band at ${(outcome.confidence ?? 0).toFixed(2)}`;
  const reasons = [];
  if (outcome.uncovered.length > 0) reasons.push(`uncovered ${outcome.uncovered.join(",")}`);
  if (outcome.addedRequirement?.value) reasons.push("added a requirement");
  return reasons.length === 0 ? "every part covered, nothing added" : reasons.join(" and ");
}

function restatementVerdictLine(record) {
  const parts = record.outcome.parts.map((p) => `${p.id}:${p.noul.toFixed(2)}`).join(" ");
  return `${parts} add:${(record.outcome.addedRequirement?.noul ?? 0).toFixed(2)} ${restatementReason(record.outcome)}`;
}

/**
 * How often the bottom band alone turned a restatement the answers liked into an escalation. The
 * spec asks for that rule and it stays; this line is so a second blind set has a number to argue
 * with rather than a feeling.
 */
function restatementExtraLines(records, push) {
  const judged = records.filter((r) => r.outcome.error === undefined);
  const bottomOnly = judged.filter(
    (r) =>
      r.outcome.verdict === "escalate" &&
      !r.outcome.parrot?.value &&
      isBottomBand(r.outcome.band) &&
      r.outcome.uncovered.length === 0 &&
      !r.outcome.addedRequirement?.value,
  );
  const ratioParrots = judged.filter((r) => r.outcome.parrot?.by === "code");
  push("");
  push("what code decided, over the judged cases");
  push(`  escalated by the bottom band alone  ${padLeft(String(bottomOnly.length), 3)} of ${judged.length}`);
  push(`  copies settled by the ratio, unasked ${padLeft(String(ratioParrots.length), 2)} of ${judged.length}`);
  for (const record of bottomOnly) {
    push(`    ${pad(record.id, 20)} labelled ${pad(record.verdict.labelled ?? "n/a", 10)} confidence ${(record.outcome.confidence ?? 0).toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// The two profiles, and the run.
// ---------------------------------------------------------------------------

const PROFILES = {
  [COMPLETION_DECISION]: {
    policy: COMPLETION_POLICY,
    labels: completionLabels,
    input: completionInput,
    call: (input, options) => completionCheck(input, options),
    grade: completionGrade,
    questionLines: completionQuestionLines,
    verdicts: ["done", "partial", "not_done"],
    verdictHeading: "done, partial or not_done",
    verdictLine: completionVerdictLine,
    extraLines: undefined,
  },
  [RESTATEMENT_DECISION]: {
    policy: RESTATEMENT_POLICY,
    labels: restatementLabels,
    input: (testCase) => restatementInput(testCase),
    call: (input, options) => taskRestatement(input, options),
    grade: restatementGrade,
    questionLines: restatementQuestionLines,
    verdicts: ["accept", "revise", "escalate"],
    verdictHeading: "accept, revise or escalate",
    verdictLine: restatementVerdictLine,
    extraLines: restatementExtraLines,
  },
};

const profile = PROFILES[decision];
if (profile === undefined) {
  console.error(`no eval profile for "${decision}". Known: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

const raw = JSON.parse(await readFile(casesPath, "utf8"));
const allCases = (Array.isArray(raw) ? raw : raw.cases).filter((c) => (only ? String(c.id).includes(only) : true));

async function runCase(testCase) {
  const labels = profile.labels(testCase);
  const input = profile.input(testCase, labels);

  let outcome;
  let attempts = 0;
  // The engine never retries a judgment; this retries the decision, which is the eval's business.
  while (attempts < maxAttempts) {
    attempts += 1;
    outcome = await profile.call(input, { policy: profile.policy, judge, ledger: nullLedger() });
    if (outcome.error === undefined || !RETRYABLE.has(outcome.error.reason)) break;
    if (attempts < maxAttempts) {
      await new Promise((done) => setTimeout(done, BASE_BACKOFF_MS * 2 ** (attempts - 1) + Math.floor(Math.random() * 250)));
    }
  }

  return { id: testCase.id, note: testCase.note, labels, outcome, attempts, ...profile.grade(testCase, labels, outcome) };
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

function pct(correct, total) {
  return total === 0 ? "n/a" : `${((correct / total) * 100).toFixed(1)}%`;
}
function pad(text, width) {
  return String(text).padEnd(width);
}
function padLeft(text, width) {
  return String(text).padStart(width);
}
function slice(grades, test) {
  const rows = grades.filter(test);
  return { rows, correct: rows.filter((row) => row.correct).length };
}

const allGrades = records.flatMap((record) => record.grades);
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
const push = (line) => lines.push(line);
push(`JDE eval, ${decision}, ${setLabel}`);
push(`${records.length} cases, ${allGrades.length} graded questions, answered by ${models.join(", ")}`);
push("");
push("accuracy by question");
profile.questionLines(allGrades, push);
push("");
push("accuracy by verdict, aggregated in code");
push(`  ${pad(profile.verdictHeading, 30)} ${padLeft(pct(verdictsCorrect, scoredVerdicts.length), 7)}  (${verdictsCorrect} of ${scoredVerdicts.length})`);
for (const verdict of profile.verdicts) {
  const rows = scoredVerdicts.filter((record) => record.verdict.labelled === verdict);
  const right = rows.filter((record) => record.verdict.correct).length;
  push(`    labelled ${pad(verdict, 21)} ${padLeft(pct(right, rows.length), 7)}  (${right} of ${rows.length})`);
}
for (const record of scoredVerdicts.filter((r) => !r.verdict.correct)) {
  push(`    ${pad(record.id, 20)} labelled ${pad(record.verdict.labelled, 10)} computed ${pad(record.verdict.computed, 10)} ${profile.verdictLine(record)}`);
}
if (profile.extraLines !== undefined) profile.extraLines(records, push);
push("");
push("accuracy by confidence, over every question the judge answered");
for (const bucket of BUCKETS) {
  const rows = allGrades.filter((g) => g.confidence !== null && g.confidence >= bucket.lo && g.confidence < bucket.hi);
  const right = rows.filter((row) => row.correct).length;
  push(`  ${pad(bucket.label, 30)} ${padLeft(pct(right, rows.length), 7)}  (${right} of ${rows.length})`);
}
push("");
for (const grade of allGrades.filter((g) => !g.correct)) {
  const record = records.find((r) => r.grades.includes(grade));
  push(`  wrong: ${pad(record.id, 20)} ${pad(grade.question, 18)} expected ${pad(grade.expected, 6)} got ${pad(grade.got, 6)} ${grade.raw === undefined ? (grade.ratio === undefined ? "" : `ratio ${grade.ratio.toFixed(2)}`) : `noul ${grade.raw.toFixed(2)}`}`);
}
if (failed.length > 0) {
  for (const record of failed) push(`  no answer: ${pad(record.id, 20)} ${record.outcome.error.reason} after ${record.attempts} attempt(s)`);
}
push("");
push(`latency p50 ${percentile(0.5)}ms, p95 ${percentile(0.95)}ms, wall ${(wallMs / 1000).toFixed(1)}s at concurrency ${concurrency}`);
push(`input tokens ${inputTokens}, about $${((inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS).toFixed(4)} at $${USD_PER_MILLION_INPUT_TOKENS} per million`);

const report = lines.join("\n");
console.log(report);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  JSON.stringify(
    {
      decision,
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
