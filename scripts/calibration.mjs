#!/usr/bin/env node
// What the ledger can say about where its own confidence is worth acting on.
//
// Usage: node scripts/calibration.mjs
//          [--ledger <path>]        default .jde/ledger.jsonl, or JDE_LEDGER_PATH
//          [--decision <name>]      only this decision
//          [--question <name>]      only this question id, such as aggregate
//          [--include <traffic>]    live, eval, or all; default live
//          [--run-id <id>]          only this evaluation run
//          [--min-reviewed <n>]     reviews a threshold needs behind it, default 100
//          [--max-error <rate>]     pooled error a threshold must be at or under, default 0.05
//          [--json]                 the numbers, for something other than a person
//
// Reviewed judgments only. A row nobody looked at is not a correct row, and this never counts one.

import { calibrateLedger, defaultLedgerPath, describeCalibration } from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const path = flag("--ledger", defaultLedgerPath());
const options = {};
const decision = flag("--decision");
const question = flag("--question");
const include = flag("--include");
const runId = flag("--run-id");
const minReviewed = flag("--min-reviewed");
const maxError = flag("--max-error");
if (decision !== undefined) options.decision = decision;
if (question !== undefined) options.question = question;
if (include !== undefined) {
  if (!["live", "eval", "all"].includes(include)) {
    console.error("--include must be live, eval, or all");
    process.exit(1);
  }
  options.include = include;
}
if (runId !== undefined) options.runId = runId;
if (minReviewed !== undefined) options.minReviewed = Number(minReviewed);
if (maxError !== undefined) options.maxPooledError = Number(maxError);

const { join, calibration } = await calibrateLedger(path, options);

if (args.includes("--json")) {
  console.log(JSON.stringify({ ledger: path, ...options, calibration }, null, 2));
} else {
  const narrowed = [decision, question].filter(Boolean).join(" / ");
  console.log(describeCalibration(join, calibration, narrowed ? `${path} (${narrowed})` : path));
}
