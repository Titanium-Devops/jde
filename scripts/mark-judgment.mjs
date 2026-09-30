#!/usr/bin/env node
// The surface a person marks a judgment through, so the ledger can hold a correctness fact at all.
//
// Usage: node scripts/mark-judgment.mjs --id <row id> --right | --wrong --by <who>
//          [--why "one line"]        why, for whoever reads the row later
//          [--ledger <path>]         default .jde/ledger.jsonl, or JDE_LEDGER_PATH
//          [--force]                 write a marker for an id this ledger does not hold
//
// It appends. It never edits the row it points at, and a later verdict never deletes an earlier
// one: both stay in the file and the reader resolves them, most recent first.

import { defaultLedgerPath, fileLedger, joinReviews, markReviewed, readLedger } from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const has = (name) => args.includes(name);

const id = flag("--id");
const by = flag("--by");
const why = flag("--why");
const path = flag("--ledger", defaultLedgerPath());
const right = has("--right");
const wrong = has("--wrong");

if (!id || !by || right === wrong) {
  console.error("Usage: node scripts/mark-judgment.mjs --id <row id> --right|--wrong --by <who> [--why \"...\"] [--ledger <path>]");
  console.error("Exactly one of --right and --wrong. A review with no reviewer is not a review.");
  process.exit(1);
}

const before = await readLedger(path);
if (before.length === 0) {
  console.error(`No ledger at ${path}. Nothing has been judged, so there is nothing to review.`);
  process.exit(1);
}

const target = before.find((entry) => entry && typeof entry === "object" && entry.id === id && "question" in entry);
if (target === undefined && !has("--force")) {
  console.error(`No judgment with id ${id} in ${path}. Pass --force to write the marker anyway.`);
  process.exit(1);
}

await markReviewed(fileLedger(path), id, { wrong, by }, why === undefined ? {} : { why });

// fileLedger never throws, on purpose, so the only proof the marker landed is reading it back.
const after = await readLedger(path);
const afterJoin = joinReviews(after, { include: "all" });
const joined = afterJoin.reviewed.find((entry) => entry.row.id === id)
  ?? afterJoin.reviewedErrorRows.find((entry) => entry.row.id === id);
const landedDangling = afterJoin.dangling.some((marker) => marker.id === id && marker.by === by);
if (joined === undefined && !landedDangling) {
  console.error(`The marker did not reach ${path}. Check the path and its permissions.`);
  process.exit(1);
}

if (joined === undefined) {
  console.log(`${id} marked ${wrong ? "wrong" : "right"} by ${by} (no matching judgment row; --force)`);
  process.exit(0);
}

const verdict = joined.review.wrong ? "wrong" : "right";
console.log(`${id} marked ${verdict} by ${joined.review.by} at ${joined.review.ts}`);
if (joined.all.length > 1) {
  console.log(`${joined.all.length} verdicts on this row; the most recent one counts and the rest stay in the file.`);
}
if (target !== undefined) {
  console.log(`  ${target.decision} / ${target.question}, answered ${target.answer} at confidence ${target.confidence}`);
}
