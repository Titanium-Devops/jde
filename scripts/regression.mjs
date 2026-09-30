#!/usr/bin/env node
// The standing suite: both spent blind sets, run against the scores they recorded.
//
// A spent set measures nothing new. Its answers are known, so anything tuned against it is tuned
// against a ruler. What it is still good for is a guard: if completion-check scores 24 of 30 where
// it scored 30 of 30, something broke today and this says so today.
//
// Usage: node scripts/regression.mjs
//          [--baseline <path>]     default regression-baseline.json
//          [--repeats <n>]         passed through to each eval, default 1
//          [--ledger <path>]       passed through, default the eval's own out/ledger/eval.jsonl
//          [--no-ledger]           passed through
//          [--endpoint <url>]      passed through, so the suite can be tested without the judge
//          [--judge jeb|jev]       default the baseline's own judge. A baseline speaks only for the
//                                  judge that recorded it, so another judge gets its own baseline
//
// Exit 1 on a drop in the QUESTION-level count, on a case that got no answer, or on a run that did
// not finish. The verdict count is printed beside it and never gated: five repeats of both sealed
// sets showed the question count perfectly stable and the verdict count moving by four cases on
// confidence drift alone, so gating it would cry wolf while hiding a real regression in the noise.
// Exit 0 otherwise. Nothing here writes to cases/ and nothing edits a baseline.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const passThrough = [];
for (const name of ["--repeats", "--ledger", "--endpoint"]) {
  const value = flag(name);
  if (value !== undefined) passThrough.push(name, value);
}
if (args.includes("--no-ledger")) passThrough.push("--no-ledger");

const baselinePath = resolve(process.cwd(), flag("--baseline", resolve(REPO, "regression-baseline.json")));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

const judgeName = flag("--judge", baseline.judge ?? "jev");
passThrough.push("--judge", judgeName);
if (judgeName === "jev" && !process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. This baseline was recorded by the hosted Jev; export it in the shell that runs this suite and try again.");
  process.exit(1);
}

function runEval(decision, outPath) {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [resolve(REPO, "scripts/eval.mjs"), "--decision", decision, "--set", "regression suite", "--out", outPath, ...passThrough],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${decision} eval exited ${code}`))));
  });
}

const pct = (correct, total) => (total === 0 ? "n/a" : `${((correct / total) * 100).toFixed(1)}%`);
const pad = (text, width) => String(text).padEnd(width);

const failures = [];
const rises = [];
const lines = [];
let tokens = 0;
let cost = 0;
let rows = 0;

for (const [decision, expected] of Object.entries(baseline.decisions)) {
  const outPath = resolve(REPO, `out/regression-${decision}.json`);
  try {
    await runEval(decision, outPath);
  } catch (error) {
    failures.push(`${decision}: the run did not finish (${error.message})`);
    continue;
  }

  const { summary } = JSON.parse(await readFile(outPath, "utf8"));
  tokens += summary.inputTokens;
  cost += summary.costUsd;
  rows += summary.ledgerRows;

  lines.push(`${pad(decision, 18)} ${summary.cases} cases, ${summary.inputTokens} tokens`);

  // The gate is the question-level count, and only that.
  //
  // Five repeats of both sealed sets moved it not once in 290 answers, while the verdict count on
  // the same runs moved by four cases with the judge never changing its mind: the verdicts turn on
  // confidences drifting across our own floors. A strict test on the noisy number cries wolf until
  // nobody reads it, and a loose one wide enough to absorb that drift would swallow a real
  // three-case regression inside the same band. So the strict test points at the stable number.
  const was = expected.questions;
  const now = summary.questions;
  const mark = now.correct < was.correct ? "DROP" : now.correct > was.correct ? "rose" : "same";
  lines.push(
    `  ${pad("questions", 10)} recorded ${pad(`${was.correct} of ${was.total}`, 12)} now ${pad(`${now.correct} of ${now.total}`, 12)} ${pad(pct(now.correct, now.total), 7)} ${mark}  <- the gate`,
  );
  if (now.total !== was.total) {
    failures.push(`${decision} questions: the set now has ${now.total} graded items and the baseline has ${was.total}. The case set changed, which a baseline cannot speak for.`);
  } else if (now.correct < was.correct) {
    failures.push(`${decision} questions: ${now.correct} of ${now.total}, and it recorded ${was.correct}. That is ${was.correct - now.correct} fewer. This number does not drift, so read it as real and check the stability block only to confirm.`);
  } else if (now.correct > was.correct) {
    rises.push(`${decision} questions: ${now.correct} of ${now.total}, above the recorded ${was.correct}. Worth reading before it is celebrated.`);
  }

  // The verdict count is reported and never gated.
  const wasVerdicts = expected.verdicts;
  const nowVerdicts = summary.verdicts;
  const seen = expected.observedVerdictRuns;
  const drift = Array.isArray(seen) && seen.length > 1
    ? `drifts, seen at ${seen.join(", ")}`
    : "not gated: it turns on confidences that drift between runs";
  lines.push(
    `  ${pad("verdicts", 10)} recorded ${pad(`${wasVerdicts.correct} of ${wasVerdicts.total}`, 12)} now ${pad(`${nowVerdicts.correct} of ${nowVerdicts.total}`, 12)} ${pad(pct(nowVerdicts.correct, nowVerdicts.total), 7)} ${drift}`,
  );
  if (summary.failures > 0) {
    failures.push(`${decision}: ${summary.failures} case(s) got no answer from the judge.`);
  }
  if (summary.stability !== null && summary.stability !== undefined) {
    const s = summary.stability;
    lines.push(`  ${pad("stability", 10)} ${s.caseFlips} of ${s.cases} cases differ between repeat 0 and 1, over ${s.repeats} repeats`);
  }
}

console.log(lines.join("\n"));
console.log("");
console.log(`${tokens} input tokens, ${(cost * 100).toFixed(2)} cents, ${rows} ledger rows`);

if (rises.length > 0) {
  console.log("");
  for (const rise of rises) console.log(`above baseline: ${rise}`);
}

if (failures.length > 0) {
  console.log("");
  console.log(`SUITE FAILED, ${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}

console.log("");
console.log("suite passed: the question level gate met or beaten on every decision");
