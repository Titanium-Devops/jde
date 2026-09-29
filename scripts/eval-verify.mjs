#!/usr/bin/env node
// Reruns a committed local-judge result and fails on any difference.
//
// The readout is deterministic (temperature 0, one request in flight, logprobs read before sampling),
// so the same GGUF on the same runtime must give the same answers to the last digit. A difference is
// one of three things, and this says which: the cases changed, the prompt changed (JDE's question
// wording, jeb's chat template or its temperatures), or the judge answered differently.
//
// Usage: npm run eval:verify -- [--file <evals/results/x.json>] [--tolerance <n>] [--runtime-url <url>]
//
// With no --file it verifies every committed result made by the judge that is up now, and fails if
// there is none, so a CI job that loaded the wrong model cannot pass by verifying nothing.

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { JEB_ENDPOINT } from "../dist/index.js";
import { evalSet, provenance, REPO, RESULTS_DIR, slim } from "./eval-local.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const tolerance = Number(flag("--tolerance", 0));
const endpoint = process.env.JDE_JEB_ENDPOINT || JEB_ENDPOINT;
const only = flag("--file", undefined);

const files = only
  ? [resolve(process.cwd(), only)]
  : (await readdir(resolve(REPO, RESULTS_DIR))).filter((name) => name.endsWith(".json")).map((name) => resolve(REPO, RESULTS_DIR, name));

let live;
try {
  live = await provenance({ endpoint, runtimeUrl: flag("--runtime-url", process.env.JDE_RUNTIME_URL), setPaths: [] });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const sameJudge = (a, b) => a.weights.gguf_sha256 === b.weights.gguf_sha256 && a.runtime === b.runtime;
const committed = [];
for (const file of files) {
  const result = JSON.parse(await readFile(file, "utf8"));
  if (result.schema !== "jde-eval-local/1") continue;
  if (sameJudge(result, live)) committed.push({ file, result });
  else if (only) {
    console.error(`${file} was made by ${result.model} ${result.quant} on ${result.runtime} (gguf ${result.weights.gguf_sha256?.slice(0, 12)}), but the judge up now is ${live.model} ${live.quant} on ${live.runtime} (gguf ${live.weights.gguf_sha256?.slice(0, 12)})`);
    process.exit(1);
  }
}
if (committed.length === 0) {
  console.error(`No committed result was made by the judge that is up now (${live.model} ${live.quant} on ${live.runtime}). Nothing verified.`);
  process.exit(1);
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  FAIL ${message}`);
};

for (const { file, result } of committed) {
  console.log(`verifying ${relative(process.cwd(), file)}`);
  const now = await provenance({ endpoint, runtimeUrl: flag("--runtime-url", process.env.JDE_RUNTIME_URL), setPaths: result.sets.map((s) => s.path) });

  if (now.judge.runtime_version !== result.judge.runtime_version) {
    console.log(`  note: ${result.runtime} is ${now.judge.runtime_version} here, ${result.judge.runtime_version} when committed`);
  }
  if (now.prompt.sha256 !== result.prompt.sha256) {
    fail(`the prompt changed (questions ${now.prompt.questions_sha256 === result.prompt.questions_sha256 ? "same" : "reworded"}, chat template or temperatures ${now.prompt.jeb_repo_revision === result.prompt.jeb_repo_revision ? "same revision" : `revision ${now.prompt.jeb_repo_revision} vs ${result.prompt.jeb_repo_revision}`}). That is a new measurement: rerun eval:local and commit it.`);
    continue;
  }

  for (const set of result.sets) {
    const current = now.sets.find((s) => s.path === set.path);
    if (current.sha256 !== set.sha256) {
      fail(`${set.path} changed since it was measured (sha256 ${current.sha256.slice(0, 12)}, committed ${set.sha256.slice(0, 12)})`);
      continue;
    }
    const rerun = slim(await evalSet(set.path, { model: result.model, timeoutMs: 120000 }));
    let worst = 0;
    const before = new Map(set.records.map((r) => [r.id, r]));
    for (const record of rerun.records) {
      const old = before.get(record.id);
      if (!old) {
        fail(`${set.path} ${record.id}: not in the committed result`);
        continue;
      }
      if (record.error) fail(`${set.path} ${record.id}: no answer (${record.error})`);
      if (record.verdict !== old.verdict) fail(`${set.path} ${record.id}: verdict ${record.verdict}, committed ${old.verdict}`);
      for (const [id, value] of Object.entries(old.answers)) {
        const diff = Math.abs((record.answers[id] ?? Number.NaN) - value);
        worst = Math.max(worst, Number.isNaN(diff) ? Infinity : diff);
        if (!(diff <= tolerance)) fail(`${set.path} ${record.id} ${id}: ${record.answers[id]}, committed ${value}`);
      }
    }
    const s = rerun.summary;
    console.log(`  ${set.path}: ${rerun.records.length} cases, verdicts ${s.verdict.correct}/${s.verdict.of}, largest answer difference ${worst}`);
  }
}

if (failures > 0) {
  console.error(`${failures} difference(s). The committed numbers do not reproduce.`);
  process.exit(1);
}
console.log("reproduced exactly");
