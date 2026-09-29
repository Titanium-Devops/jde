#!/usr/bin/env node
// Prints the README's proof table and the cases where the local judges and hosted Jev disagree,
// counted from the files in evals/, so no number in the README is typed by hand.
//
// Usage: node scripts/results-table.mjs [--set cases/completion-check-public.json]

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--set");
const setPath = at === -1 ? "cases/completion-check-public.json" : args[at + 1];

async function load(dir) {
  const folder = join(REPO, "evals", dir);
  let names = [];
  try {
    names = (await readdir(folder)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), "utf8"))));
}

const SIZE_ORDER = (model) => Number(/(\d+)b/.exec(model)?.[1] ?? 1e9);
const local = (await load("results")).sort((a, b) => SIZE_ORDER(a.model) - SIZE_ORDER(b.model) || a.runtime.localeCompare(b.runtime));
const hosted = await load("comparison");

const setOf = (result) => result.sets.find((s) => s.path === setPath);
const frac = (c) => `${c.correct} of ${c.of}`;
const label = (r) => r.model.replace(/^jebadiah-/, "Jeb ").replace(/-v2$/, " v2").replace(/(\d+)b/, (_, n) => `${n}B`);

// One row per model when every runtime gave the same answers; the runtimes are named in the row.
const rows = new Map();
for (const r of local) {
  const set = setOf(r);
  if (!set) continue;
  const key = `${r.model} ${r.quant}`;
  const answers = JSON.stringify(set.records.map((x) => x.answers));
  const row = rows.get(key) ?? { r, set, runtimes: [], answers, same: true, p50: [] };
  if (row.answers !== answers) row.same = false;
  row.runtimes.push(`${r.runtime} ${r.judge.runtime_version}`);
  row.p50.push(set.latency_ms.p50);
  rows.set(key, row);
}

console.log(`| Judge | Verdict right | Parts judged right | Echo caught | Median latency | Runs on |`);
console.log(`|---|---|---|---|---|---|`);
for (const row of rows.values()) {
  const s = row.set.summary;
  const runtimes = row.runtimes.join(", ") + (row.runtimes.length > 1 ? (row.same ? " (identical answers)" : " (answers differ)") : "");
  console.log(`| **${label(row.r)}** ${row.r.quant}, local | **${frac(s.verdict)}** | ${frac(s.judged_parts)} | ${frac(s.echo)} | ${Math.min(...row.p50)} ms | ${runtimes} |`);
}
for (const h of hosted) {
  const set = setOf(h);
  if (!set) continue;
  const s = set.summary;
  console.log(`| *For comparison: hosted Jev (${h.model.replace(/^jev-/, "")})* | *${frac(s.verdict)}* | *${frac(s.judged_parts)}* | *${frac(s.echo)}* | *${set.latency_ms.p50} ms* | *TypeSafe's API* |`);
}

// Where the verdicts part ways, case by case.
console.log("");
const judges = [...rows.values()].map((row) => ({ name: label(row.r), set: row.set })).concat(hosted.filter(setOf).map((h) => ({ name: "Jev", set: setOf(h) })));
if (judges.length > 1) {
  const ids = judges[0].set.records.map((r) => r.id);
  console.log(`| Case | Labelled | ${judges.map((j) => j.name).join(" | ")} |`);
  console.log(`|---|---|${judges.map(() => "---").join("|")}|`);
  for (const id of ids) {
    const verdicts = judges.map((j) => j.set.records.find((r) => r.id === id));
    const labelled = verdicts[0].labels.done;
    if (verdicts.every((v) => v.verdict === labelled)) continue;
    console.log(`| \`${id}\` | ${labelled} | ${verdicts.map((v) => (v.verdict === labelled ? v.verdict : `**${v.verdict}**`)).join(" | ")} |`);
  }
}
