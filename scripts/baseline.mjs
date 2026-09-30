#!/usr/bin/env node
// What a case set scores before anyone judges it.
//
// Usage: node scripts/baseline.mjs [<case file> ...]
//          [--markdown]   tables, for docs/baselines.md
//          [--json]       the numbers, for something other than a person
//
// With no files it reads every case file in cases/. For each label field it prints the label
// distribution, the accuracy of always answering the most common label, the prior's mean multiclass
// Brier loss, and, where a run was recorded, that score expressed as a Decision Score: 100 perfect,
// 0 no better than the base rates, negative worse.
//
// No API key, no model, no network. It reads the files and does arithmetic.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  accuracyDecisionScore,
  labelFields,
  majorityBaseline,
  priorBrierLoss,
} from "../src/baseline.ts";

const ROOT = resolve(import.meta.dirname, "..");

// What the repo says these sets scored, and where it says it. A field with no row here was never
// run, and the script says so rather than inventing a number.
const RECORDED = {
  "completion-check-blind.json": {
    "parts[]": { correct: 69, n: 69, source: "USAGE.md, every part, code and judge" },
    done: { correct: 30, n: 30, source: "README.md, correct verdict" },
    result_is_echo: { correct: 30, n: 30, source: "README.md, prompt restated instead of answered" },
  },
  "task-restatement-blind.json": {
    verdict: { correct: 36, n: 40, source: "USAGE.md, accept / revise / escalate" },
    "parts{}": { correct: 146, n: 149, source: "USAGE.md, coverage, one question per task part" },
    addedRequirement: { correct: 35, n: 40, source: "USAGE.md, added a requirement" },
    parrot: { correct: 40, n: 40, source: "USAGE.md, is a copy, code and judge" },
  },
};

const args = process.argv.slice(2);
const wantsMarkdown = args.includes("--markdown");
const wantsJson = args.includes("--json");
const named = args.filter((a) => !a.startsWith("--"));

const paths = named.length
  ? named.map((p) => resolve(p))
  : readdirSync(join(ROOT, "cases"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(ROOT, "cases", f));

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const signed = (x) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`);

const report = paths.map((path) => {
  const name = basename(path);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    return { file: name, path, cases: 0, note: "not a list of cases, so it has no labels to count", fields: [], skipped: [] };
  }
  const { cases, fields, skipped } = labelFields(parsed);
  const recorded = RECORDED[name] ?? {};
  return {
    file: name,
    path,
    cases,
    fields: fields.map((field) => {
      const d = field.distribution;
      const majority = majorityBaseline(d);
      const prior = priorBrierLoss(d);
      const run = recorded[field.name] ?? null;
      const accuracy = run ? run.correct / run.n : null;
      return {
        name: field.name,
        unit: field.unit,
        block: field.block,
        pooledFrom: field.pooledFrom ?? null,
        n: d.n,
        labels: Object.entries(d.counts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, count]) => ({ label, count, share: count / d.n })),
        majority: { label: majority.label, accuracy: majority.accuracy },
        priorBrierLoss: prior,
        recorded: run ? { ...run, accuracy, sameDenominator: run.n === d.n } : null,
        decisionScore: accuracy === null ? null : accuracyDecisionScore(accuracy, majority.accuracy),
      };
    }),
    skipped,
  };
});

if (wantsJson) {
  console.log(JSON.stringify({ ran_at: new Date().toISOString(), report }, null, 2));
} else if (wantsMarkdown) {
  for (const set of report) {
    console.log(`### \`cases/${set.file}\``);
    console.log();
    if (set.note) {
      console.log(`${set.note}.`);
      console.log();
      continue;
    }
    console.log(`${set.cases} cases.`);
    console.log();
    console.log("| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |");
    console.log("|---|---|---:|---|---:|---:|---|---:|");
    for (const f of set.fields) {
      const dist = f.labels.map((l) => `${l.label} ${l.count}`).join(", ");
      const run = f.recorded ? `${f.recorded.correct} of ${f.recorded.n}, ${pct(f.recorded.accuracy)}` : "never run";
      console.log(
        `| \`${f.name}\` | ${f.unit} | ${f.n} | ${dist} | ${pct(f.majority.accuracy)} | ${f.priorBrierLoss.toFixed(3)} | ${run} | ${f.recorded ? signed(f.decisionScore) : "n/a"} |`,
      );
    }
    console.log();
    for (const s of set.skipped) console.log(`- Not a label field: \`${s.block}.${s.name}\`, ${s.reason}.`);
    if (set.skipped.length) console.log();
  }
} else {
  for (const set of report) {
    console.log(`=== cases/${set.file}`);
    if (set.note) {
      console.log(`    ${set.note}`);
      console.log();
      continue;
    }
    console.log(`    ${set.cases} cases`);
    for (const f of set.fields) {
      const pooled = f.pooledFrom ? `  pooled from ${f.pooledFrom.join(", ")}` : "";
      console.log(`  ${f.name}  (${f.n} ${f.unit}${f.n === 1 ? "" : "s"}${pooled})`);
      console.log(`      labels            ${f.labels.map((l) => `${l.label} ${l.count} (${pct(l.share)})`).join(", ")}`);
      console.log(`      majority baseline ${pct(f.majority.accuracy)}, always answering ${f.majority.label}`);
      console.log(`      prior Brier loss  ${f.priorBrierLoss.toFixed(3)}`);
      if (f.recorded) {
        const denominator = f.recorded.sameDenominator ? "" : `  (recorded over ${f.recorded.n}, this field counts ${f.n})`;
        console.log(`      recorded          ${f.recorded.correct} of ${f.recorded.n}, ${pct(f.recorded.accuracy)}${denominator}`);
        console.log(`      decision score    ${signed(f.decisionScore)}  (100 perfect, 0 the baseline)`);
        console.log(`      source            ${f.recorded.source}`);
      } else {
        console.log(`      recorded          never run against this set`);
      }
    }
    for (const s of set.skipped) console.log(`  skipped ${s.block}.${s.name}: ${s.reason}`);
    console.log();
  }
}
