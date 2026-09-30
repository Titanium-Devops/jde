#!/usr/bin/env node
// Scores extractTaskParts() against the parts a person wrote by hand.
//
// The two completion check case sets carry 61 tasks with their parts already labelled, by the
// people who wrote those sets rather than by whoever wrote the parser. That makes them the only
// ground truth this extractor has. It is a DEVELOPMENT set, not a blind one: the parser was
// iterated against these numbers, so read them as an upper bound. A blind set for the extractor
// would be a fresh file of tasks and parts written by someone who has not seen src/parts.ts.
//
// No case file is ever edited by this script, and nothing here writes to cases/.
//
// Usage: node scripts/parts-eval.mjs
//          [--cases <path>]     repeatable, default both completion check sets
//          [--out <path>]       write the raw records as JSON
//          [--quiet]            counts only, no mismatch listing
//
// Run npm run build first: this reads the compiled extractor from dist/, the way a caller would.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTaskParts } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const outAt = args.indexOf("--out");
const outPath = outAt === -1 ? null : resolve(process.cwd(), args[outAt + 1]);
const casePaths = args.reduce((paths, arg, at) => {
  if (arg === "--cases") paths.push(resolve(process.cwd(), args[at + 1]));
  return paths;
}, []);
if (casePaths.length === 0) {
  casePaths.push(resolve(REPO, "cases/completion-check-tuned.json"));
  casePaths.push(resolve(REPO, "cases/completion-check-blind.json"));
}

// Words that carry no meaning to compare. Numbers stay: "three providers" is part of the object.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "into", "for", "at", "on", "onto", "and", "or", "it", "its",
  "them", "they", "you", "your", "me", "my", "we", "our", "us", "with", "from", "that", "this",
  "these", "those", "which", "what", "whether", "is", "are", "be", "was", "were", "as", "by", "i",
  "their", "there", "here", "then", "so", "up", "out", "each", "any", "all", "under", "over",
]);

// Verbs that mean the same work. Two texts match on their verb when their classes agree, which is
// what lets "find out which libraries" match a hand written "search for libraries".
const VERB_CLASSES = new Map(Object.entries({
  search: "look-up", research: "look-up", find: "look-up", look: "look-up", investigate: "look-up",
  check: "visit", open: "visit", visit: "visit", browse: "visit", navigate: "visit", view: "visit",
  fetch: "gather", pull: "gather", download: "gather", get: "gather", retrieve: "gather",
  scrape: "gather", crawl: "gather", read: "gather", collect: "gather",
  run: "run", execute: "run", test: "run", build: "run",
  write: "produce", save: "produce", put: "produce", record: "produce", store: "produce",
  add: "produce", create: "produce", make: "produce", document: "produce", append: "produce",
  export: "produce", extract: "produce", generate: "produce", draft: "produce", compose: "produce",
  update: "produce", edit: "produce", fix: "produce", patch: "produce", rename: "produce",
  implement: "produce", insert: "produce", log: "produce",
  tell: "answer", state: "answer", say: "answer", report: "answer", name: "answer",
  recommend: "answer", suggest: "answer", give: "answer", explain: "answer", answer: "answer",
  describe: "answer", summarise: "answer", summarize: "answer", list: "answer", show: "answer",
  identify: "answer", pick: "answer", choose: "answer", select: "answer", confirm: "answer",
}));

const words = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9/.\-_ ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");

const contentWords = (text) => new Set(words(text).filter((word) => !STOPWORDS.has(word)));

function verbClassOf(text) {
  for (const word of words(text)) {
    const found = VERB_CLASSES.get(word);
    if (found !== undefined) return found;
  }
  return null;
}

/** Lenient on purpose: a hand written part is a rewrite, so this asks for the verb and the object. */
function textMatch(expected, got) {
  const expectedClass = verbClassOf(expected);
  const gotClass = verbClassOf(got);
  const verbOk =
    expectedClass === null || gotClass === null ? words(expected)[0] === words(got)[0] : expectedClass === gotClass;
  const want = contentWords(expected);
  const have = contentWords(got);
  let shared = 0;
  for (const word of want) if (have.has(word)) shared += 1;
  const overlap = want.size === 0 ? 0 : shared / want.size;
  return { verbOk, overlap, pass: verbOk && overlap >= 0.34 };
}

function scoreCase(testCase) {
  const task = testCase.state.task;
  const expected = testCase.state.task_parts ?? [];
  const got = extractTaskParts(task);
  const width = Math.max(expected.length, got.length);
  const parts = [];
  for (let index = 0; index < width; index += 1) {
    const want = expected[index];
    const have = got[index];
    const kindOk = want !== undefined && have !== undefined && want.kind === have.kind;
    const wantsPath = want !== undefined && want.kind === "file";
    const pathOk = wantsPath && have !== undefined && have.kind === "file" && have.path === want.path;
    const text = want !== undefined && have !== undefined ? textMatch(want.text, have.text) : null;
    parts.push({
      index,
      expected: want ?? null,
      got: have ?? null,
      kindOk,
      wantsPath,
      pathOk,
      textOk: text !== null && text.pass,
      overlap: text === null ? 0 : text.overlap,
    });
  }
  const countOk = expected.length === got.length;
  const structureOk = countOk && parts.every((part) => part.kindOk && (!part.wantsPath || part.pathOk));
  return { id: testCase.id, task, expected, got, countOk, structureOk, parts };
}

function tally(results) {
  const counts = {
    cases: results.length,
    countOk: 0,
    structureOk: 0,
    parts: 0,
    kindOk: 0,
    filePartsExpected: 0,
    pathOk: 0,
    textOk: 0,
    overlapSum: 0,
  };
  for (const result of results) {
    if (result.countOk) counts.countOk += 1;
    if (result.structureOk) counts.structureOk += 1;
    for (const part of result.parts) {
      counts.parts += 1;
      if (part.kindOk) counts.kindOk += 1;
      if (part.wantsPath) counts.filePartsExpected += 1;
      if (part.pathOk) counts.pathOk += 1;
      if (part.textOk) counts.textOk += 1;
      counts.overlapSum += part.overlap;
    }
  }
  return counts;
}

const percent = (top, bottom) => (bottom === 0 ? "n/a" : `${((100 * top) / bottom).toFixed(1)}%`);

function report(label, counts) {
  console.log(`\n${label}`);
  console.log(`  cases                      ${counts.cases}`);
  console.log(`  exact part count           ${counts.countOk}/${counts.cases}  ${percent(counts.countOk, counts.cases)}`);
  console.log(`  count + kinds + paths      ${counts.structureOk}/${counts.cases}  ${percent(counts.structureOk, counts.cases)}`);
  console.log(`  kind per part              ${counts.kindOk}/${counts.parts}  ${percent(counts.kindOk, counts.parts)}`);
  console.log(`  path per file part         ${counts.pathOk}/${counts.filePartsExpected}  ${percent(counts.pathOk, counts.filePartsExpected)}`);
  console.log(`  text, verb and object      ${counts.textOk}/${counts.parts}  ${percent(counts.textOk, counts.parts)}`);
  console.log(`  mean word overlap          ${(counts.overlapSum / Math.max(counts.parts, 1)).toFixed(2)}`);
}

const describe = (part) =>
  part === null ? "(none)" : `${part.kind}${part.kind === "file" ? ` [${part.path}]` : ""}: ${part.text}`;

const files = [];
const everything = [];
for (const path of casePaths) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const cases = Array.isArray(raw) ? raw : (raw.cases ?? Object.values(raw));
  // The same task appears in several cases of a set. Each one is scored, because that is the
  // distribution the extractor actually meets, and the distinct count is reported beside it.
  const results = cases.map(scoreCase);
  const distinct = new Set(results.map((result) => result.task)).size;
  files.push({ path, distinct, results });
  everything.push(...results);
}

console.log("Task parts extractor, scored against hand written parts.");
console.log("These sets are a DEVELOPMENT set for the extractor: the parser was iterated against");
console.log("them. They are blind only to the completion check, whose questions they were written");
console.log("for. Treat every number below as an upper bound.");

for (const file of files) {
  report(`${file.path.replace(`${REPO}/`, "")}  (${file.distinct} distinct tasks)`, tally(file.results));
}
report("both sets", tally(everything));

if (!quiet) {
  const failures = everything.filter((result) => !result.structureOk);
  const seen = new Set();
  console.log(`\nmismatches on structure, one entry per distinct task (${failures.length} cases affected)\n`);
  for (const failure of failures) {
    if (seen.has(failure.task)) continue;
    seen.add(failure.task);
    console.log(`${failure.id}${failure.countOk ? "" : "  [count]"}`);
    console.log(`  task      ${failure.task}`);
    for (const part of failure.parts) {
      const flags = [
        part.kindOk ? "" : "kind",
        part.wantsPath && !part.pathOk ? "path" : "",
        part.textOk ? "" : "text",
      ].filter((flag) => flag !== "");
      console.log(`  ${part.index}  want  ${describe(part.expected)}`);
      console.log(`     got   ${describe(part.got)}${flags.length === 0 ? "" : `   <- ${flags.join(", ")}`}`);
    }
    console.log("");
  }

  const textOnly = everything.filter((result) => result.structureOk && result.parts.some((part) => !part.textOk));
  const seenText = new Set();
  console.log(`text only mismatches, structure correct (${textOnly.length} cases affected)\n`);
  for (const result of textOnly) {
    if (seenText.has(result.task)) continue;
    seenText.add(result.task);
    for (const part of result.parts) {
      if (part.textOk) continue;
      console.log(`  ${result.id}  want  ${describe(part.expected)}`);
      console.log(`     ${" ".repeat(result.id.length)}  got   ${describe(part.got)}  overlap ${part.overlap.toFixed(2)}`);
    }
  }
}

if (outPath !== null) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ files: files.map((file) => ({ path: file.path, results: file.results })) }, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
}
