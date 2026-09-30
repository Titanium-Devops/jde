#!/usr/bin/env node
// Runs a decision against a case set through the real judge, and reports what it got right.
//
// The judge is a local Jeb by default (jeb serve on localhost:8100, or JDE_JEB_ENDPOINT); --judge jev
// uses TypeSafe's hosted Jev instead, with its key read from TYPESAFE_API_KEY by the judge and from
// nowhere else. No key is ever printed, logged or written to the output file. Every case in cases/
// is synthetic.
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
//          [--judge jeb|jev]       default jeb (a local Jeb); jev is the hosted service
//          [--repeats <n>]         ask every case n times, identical request, default 1. Repeat 0
//                                  is the one graded and reported; the rest measure whether the
//                                  judge gives the same answer twice
//          [--ledger <path>]       judgments are appended here, default out/ledger/eval.jsonl
//          [--no-ledger]           discard the judgments instead of recording them
//          [--endpoint <url>]      a stand in for the judge, so the harness itself can be tested
//                                  offline before a blind set is spent on it
//
// Every judgment goes to a ledger, because a decision engine that never records its own judgments
// can never learn where its confidence is worth acting on. Three things keep that safe. The rows
// carry no state text, which is the ledger's own rule and does not bend here. Every row is stamped
// runKind "eval" by the sink, so a reader can never mistake a judgment about a case somebody wrote
// to be judged for a decision made about a real person's work. And the default path is under out/,
// which git ignores, well away from cases/.
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
  answerText,
  ASK_GATE_DECISION,
  askGate,
  completionCheck,
  COMPLETION_DECISION,
  fileLedger,
  isBottomBand,
  jebJudge,
  jevJudge,
  normaliseParts,
  nullLedger,
  partQuestionId,
  RESTATEMENT_DECISION,
  taggedLedger,
  taskRestatement,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CODE_OWNED = "computed_by_code";
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
const RETRYABLE = new Set(["http_error", "network", "timeout"]);
const BASE_BACKOFF_MS = 600;

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
// Grade a run that already happened, from its own out/ file, without calling the judge again. A
// harness bug in reading labels is not a reason to spend a blind set twice, and re-running one to
// fix a reader would replace a measurement with a second, differently conditioned measurement.
const regradeFrom = flag("--regrade", undefined);
const repeats = Math.max(1, Number(flag("--repeats", 1)));
const ledgerPath = resolve(process.cwd(), flag("--ledger", resolve(REPO, "out/ledger/eval.jsonl")));
const keepLedger = !args.includes("--no-ledger");

const judgeName = flag("--judge", "jeb");
if (judgeName !== "jeb" && judgeName !== "jev") {
  console.error(`--judge must be jeb or jev, not ${judgeName}`);
  process.exit(1);
}
if (judgeName === "jev" && !process.env.TYPESAFE_API_KEY && regradeFrom === undefined) {
  console.error("TYPESAFE_API_KEY is not set. The hosted Jev judge needs it; export it in the shell that runs this script and try again.");
  process.exit(1);
}

const judgeOptions = endpoint === undefined ? {} : { endpoint };
const judge = judgeName === "jev" ? jevJudge(judgeOptions) : jebJudge(judgeOptions);

// One run, one id, stamped by the sink rather than by each call: a harness that has to remember a
// field on every judgment is a harness that forgets it on one, and an untagged eval row is
// indistinguishable from a live one forever after.
const runId = `${decision}:${setLabel}:${new Date().toISOString()}`;
const ledger = keepLedger ? taggedLedger(fileLedger(ledgerPath), { runKind: "eval", runId }) : nullLedger();

// ---------------------------------------------------------------------------
// completion-check: did the agent do the work.
// ---------------------------------------------------------------------------

// The eval's own policy. The bands and the aggregate are the shipped ones; only the deadline moves,
// because the shipped deadline is the budget a live turn can spend waiting and not the budget a measurement has.
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

/** A case set writes its state under `state`; a bare case is read as its own state. */
function restatementState(testCase) {
  return testCase.state ?? testCase;
}

function restatementParts(testCase) {
  const state = restatementState(testCase);
  const given = state.taskParts ?? state.task_parts;
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
  const state = restatementState(testCase);
  return {
    task: state.task,
    ...(parts === undefined ? {} : { taskParts: parts }),
    restatement: state.restatement,
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


// ---------------------------------------------------------------------------
// ask-gate: is this question the person's to answer.
// ---------------------------------------------------------------------------

const ASK_GATE_POLICY = {
  [ASK_GATE_DECISION]: {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "pass_flagged" },
    ],
    aggregate: "min_confidence",
    on_error: "pass",
    timeout_ms: timeoutMs,
  },
};

/**
 * A blind set is written before this script knows what it will look like, so every label is read
 * through the names it might plausibly carry rather than the one name this harness would have
 * chosen. A label it cannot read is not graded, and the report says how many that was, which is
 * the only honest way to find out that a reader missed a field.
 */
function pick(source, ...names) {
  for (const name of names) {
    if (source !== null && source !== undefined && source[name] !== undefined) return source[name];
  }
  return undefined;
}

function normVerdict(value) {
  if (typeof value !== "string") return undefined;
  const flat = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (flat === "suppress" || flat === "suppressed" || flat === "hold" || flat === "held") return "suppress";
  if (flat === "pass_flagged" || flat === "passflagged" || flat === "flagged" || flat === "pass_flag") return "pass_flagged";
  if (flat === "pass" || flat === "send" || flat === "ask") return "pass";
  return undefined;
}

function normKind(value) {
  if (typeof value !== "string") return undefined;
  const flat = value.trim().toLowerCase();
  return ["runnable", "preference", "blocked", "none_of_these"].includes(flat) ? flat : undefined;
}

function normTool(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const flat = value.trim();
  if (flat.length === 0 || /^(none|no_tool|no tool|null|n\/a)$/i.test(flat)) return null;
  return flat;
}

function normBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const flat = value.trim().toLowerCase();
  if (flat === "true" || flat === "yes") return true;
  if (flat === "false" || flat === "no") return false;
  return undefined;
}

function askGateStateOf(testCase) {
  const state = testCase.state ?? testCase;
  return {
    question: pick(state, "question", "message", "text", "outbound"),
    taskSummary: pick(state, "taskSummary", "task_summary", "task", "summary"),
    toolManifest: pick(state, "toolManifest", "tool_manifest", "tools", "manifest", "skills"),
    recentToolCalls: pick(state, "recentToolCalls", "recent_tool_calls", "recentCalls", "recent_calls", "toolCalls"),
  };
}

/**
 * The blind set calls the classification `verdict`, and labels no band at all. That is worth
 * reading twice, because this harness first guessed the other way round and graded nothing: it
 * looked for runnable under `kind` and for a band under `verdict`, found a band vocabulary where a
 * classification was, and scored zero of forty without saying so. Hence `preflight()` below.
 *
 * So the band is derived, from the labels the author did write, through the same rule code uses.
 * That holds the aggregation constant and measures the judge, and it is not the same thing as a
 * band the author signed off: nothing here can tell you whether they would have agreed with the
 * rule, only whether the judge's answers reach the end of it in the same place their labels do.
 */
function askGateLabels(testCase) {
  const expected = testCase.expected ?? {};
  const kind = normKind(pick(expected, "verdict", "kind", "classification", "category", "class", "type", "label"));
  const tool = normTool(pick(expected, "tool", "chosenTool", "chosen_tool", "expectedTool", "expected_tool", "toolName", "tool_name"));
  const tried = normBool(pick(expected, "alreadyTried", "already_tried", "tried", "alreadyAttempted", "already_attempted"));
  const labelled = normVerdict(pick(expected, "band", "action", "outcome", "decision"));
  return { kind, tool, tried, verdict: labelled ?? derivedVerdict(kind, tool, tried), derived: labelled === undefined };
}

/** The band the set did not label, worked out from the labels it did, by the rule in askGateVerdict. */
function derivedVerdict(kind, tool, tried) {
  if (kind === undefined) return undefined;
  if (kind !== "runnable") return "pass";
  return tool !== null && tool !== undefined && tried !== true ? "suppress" : "pass_flagged";
}

function askGateInput(testCase) {
  const state = askGateStateOf(testCase);
  return {
    question: String(state.question ?? ""),
    ...(state.taskSummary === undefined ? {} : { taskSummary: String(state.taskSummary) }),
    ...(state.toolManifest === undefined ? {} : { toolManifest: state.toolManifest }),
    ...(state.recentToolCalls === undefined ? {} : { recentToolCalls: state.recentToolCalls }),
  };
}

/**
 * Each answer is graded as itself, and the verdict is graded as what code would actually have done.
 * The tool pick is only graded where the set said which tool it wanted; a set that labels only the
 * verdict still grades, on one row instead of four.
 */
function askGateGrade(testCase, labels, outcome) {
  const grades = [];
  const scored = labels.verdict !== undefined;
  if (outcome.error !== undefined) {
    return { grades, verdict: { labelled: labels.verdict, computed: null, correct: false, scored } };
  }

  if (labels.kind !== undefined) {
    grades.push({
      question: "question_kind", kind: "kind", by: "judge",
      expected: labels.kind, got: outcome.kind ?? "none",
      correct: outcome.kind === labels.kind, confidence: outcome.kindConfidence,
    });
  }

  if (labels.tool !== undefined) {
    const got = outcome.tool?.name ?? null;
    grades.push({
      question: "answering_tool", kind: "tool", by: "judge",
      expected: labels.tool ?? "no_tool", got: got ?? "no_tool",
      correct: got === labels.tool, confidence: outcome.tool?.confidence ?? null,
    });
  }

  if (labels.tried !== undefined) {
    const noul = outcome.alreadyTried.noul;
    grades.push({
      question: "already_tried", kind: "tried",
      by: outcome.alreadyTried.noul === null ? "code" : "judge",
      expected: labels.tried, got: outcome.alreadyTried.value,
      correct: outcome.alreadyTried.value === labels.tried,
      ...(noul === null ? {} : { raw: noul }),
      confidence: noul === null ? null : Math.max(noul, 1 - noul),
    });
  }

  return {
    grades,
    verdict: { labelled: labels.verdict, computed: outcome.verdict, correct: scored ? outcome.verdict === labels.verdict : null, scored },
  };
}

function askGateQuestionLines(allGrades, push) {
  const kind = slice(allGrades, (g) => g.kind === "kind");
  const tool = slice(allGrades, (g) => g.kind === "tool");
  const tried = slice(allGrades, (g) => g.kind === "tried");
  const triedByCode = slice(allGrades, (g) => g.kind === "tried" && g.by === "code");
  const triedByJudge = slice(allGrades, (g) => g.kind === "tried" && g.by === "judge");
  const every = slice(allGrades, () => true);
  push(`  question_kind, a three way pick ${padLeft(pct(kind.correct, kind.rows.length), 7)}  (${kind.correct} of ${kind.rows.length})`);
  for (const one of ["runnable", "preference", "blocked"]) {
    const rows = kind.rows.filter((row) => row.expected === one);
    const right = rows.filter((row) => row.correct).length;
    push(`    labelled ${pad(one, 21)} ${padLeft(pct(right, rows.length), 7)}  (${right} of ${rows.length})`);
  }
  push(`  answering_tool, from the manifest${padLeft(pct(tool.correct, tool.rows.length), 7)}  (${tool.correct} of ${tool.rows.length})`);
  push(`  already_tried, code and judge   ${padLeft(pct(tried.correct, tried.rows.length), 7)}  (${tried.correct} of ${tried.rows.length})`);
  push(`    settled with no model at all  ${padLeft(pct(triedByCode.correct, triedByCode.rows.length), 7)}  (${triedByCode.correct} of ${triedByCode.rows.length})`);
  push(`    asked of the judge            ${padLeft(pct(triedByJudge.correct, triedByJudge.rows.length), 7)}  (${triedByJudge.correct} of ${triedByJudge.rows.length})`);
  push(`  every question                  ${padLeft(pct(every.correct, every.rows.length), 7)}  (${every.correct} of ${every.rows.length})`);
}

function askGateVerdictLine(record) {
  const outcome = record.outcome;
  const kind = `${outcome.kind ?? "none"}@${(outcome.kindConfidence ?? 0).toFixed(2)}`;
  return `kind=${kind} tool=${outcome.tool?.name ?? "none"} tried=${outcome.alreadyTried.value} ${outcome.reason}`;
}

/**
 * The asymmetry, which is the whole point of this gate. Sending a question the bot could have run
 * costs a person one sentence. Holding back a question the person needed to see costs them a bot
 * that went quiet, and the spec says that failure must not exist. They are counted apart.
 */
function askGateExtraLines(records, push) {
  const judged = records.filter((r) => r.outcome.error === undefined && r.verdict.scored);
  const shouldReach = judged.filter((r) => r.verdict.labelled !== "suppress");
  const swallowed = shouldReach.filter((r) => r.outcome.verdict === "suppress");
  const shouldHold = judged.filter((r) => r.verdict.labelled === "suppress");
  const notHeld = shouldHold.filter((r) => r.outcome.verdict !== "suppress");
  const unsureOnly = judged.filter((r) => r.outcome.verdict === "pass_flagged" && r.outcome.reason.includes("not sure enough"));
  const unread = records.filter((r) => r.labels.verdict === undefined).length;
  push("");
  push("the error that matters, and the one that does not");
  push(`  held back a question the set sends to a person  ${padLeft(String(swallowed.length), 3)} of ${shouldReach.length}`);
  push(`  sent a question the set says a tool answers     ${padLeft(String(notHeld.length), 3)} of ${shouldHold.length}`);
  push(`  flagged only because the judge was unsure       ${padLeft(String(unsureOnly.length), 3)} of ${judged.length}`);
  push(`  cases whose verdict label could not be read     ${padLeft(String(unread), 3)} of ${records.length}`);
  const derived = records.filter((r) => r.labels.derived).length;
  if (derived > 0) {
    push(`  verdicts derived from the set's own labels      ${padLeft(String(derived), 3)} of ${records.length}, no band was labelled`);
  }
  for (const record of swallowed) {
    push(`    SWALLOWED ${pad(record.id, 20)} labelled ${pad(record.verdict.labelled, 12)} ${record.outcome.reason}`);
  }
}

const PROFILES = {
  [ASK_GATE_DECISION]: {
    policy: ASK_GATE_POLICY,
    labels: askGateLabels,
    input: (testCase) => askGateInput(testCase),
    call: (input, options) => askGate(input, options),
    grade: askGateGrade,
    questionLines: askGateQuestionLines,
    verdicts: ["suppress", "pass", "pass_flagged"],
    verdictHeading: "suppress, pass or pass_flagged",
    verdictLine: askGateVerdictLine,
    extraLines: askGateExtraLines,
  },
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

/**
 * Read every label before calling the judge once, and refuse to run if none of them came back.
 *
 * A blind set is written before this script knows its field names, so a reader that guesses wrong
 * fails silently: every case runs, every case costs, and every row grades nothing. That happened,
 * on a set of forty. The cheap half of the run is free and catches it, so it is not optional.
 */
function preflight(cases) {
  // completion-check calls its verdict label `done`; the other decisions call it `verdict`.
  const read = cases.filter((testCase) => {
    const labels = profile.labels(testCase);
    return (labels.verdict ?? labels.done) !== undefined;
  }).length;
  if (read > 0) return { read, total: cases.length };
  const keys = [...new Set(cases.flatMap((testCase) => Object.keys(testCase.expected ?? {})))];
  console.error(
    `${casesPath} has ${cases.length} cases and not one label this harness can read, so nothing would be graded.\n` +
      `The expected keys in that file are: ${keys.join(", ") || "none"}.\n` +
      "Teach the decision's labels() function to read them before spending the set.",
  );
  process.exit(1);
}
const labelsRead = preflight(allCases);

// Every repeat writes its own rows, so the count has to come from the calls rather than from the
// graded record, which only holds repeat 0.
let rowsWritten = 0;
let tokensSpent = 0;

async function askOnce(input) {
  let outcome;
  let attempts = 0;
  // The engine never retries a judgment; this retries the decision, which is the eval's business.
  while (attempts < maxAttempts) {
    attempts += 1;
    outcome = await profile.call(input, { policy: profile.policy, judge, ledger });
    if (outcome.error === undefined || !RETRYABLE.has(outcome.error.reason)) break;
    if (attempts < maxAttempts) {
      await new Promise((done) => setTimeout(done, BASE_BACKOFF_MS * 2 ** (attempts - 1) + Math.floor(Math.random() * 250)));
    }
  }
  rowsWritten += outcome.decisions?.length ?? 0;
  tokensSpent += outcome.usage?.inputTokens ?? 0;
  return { outcome, attempts };
}

/** What two answers to the same question have to agree on to count as the same answer. */
function comparable(outcome) {
  const answers = {};
  const confidence = {};
  for (const [id, answer] of Object.entries(outcome.answers ?? {})) {
    answers[id] = answerText(answer);
    confidence[id] = answer.type === "noul" ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence;
  }
  return {
    answers,
    confidence,
    verdict: outcome.verdict ?? null,
    action: outcome.action ?? null,
    error: outcome.error?.reason ?? null,
  };
}

async function runCase(testCase) {
  const labels = profile.labels(testCase);
  // The case id rides along as the turn id, so a person reviewing a row later can find the case it
  // judged. It is an id from a synthetic file, not the case's text: the ledger still holds no state.
  const input = { ...profile.input(testCase, labels), context: { turnId: testCase.id } };

  // Repeat 0 is the graded one, so a run with repeats reports the same headline as a run without.
  const first = await askOnce(input);
  const tries = [first];
  for (let round = 1; round < repeats; round += 1) tries.push(await askOnce(input));

  const record = {
    id: testCase.id,
    note: testCase.note,
    labels,
    outcome: first.outcome,
    attempts: first.attempts,
    ...profile.grade(testCase, labels, first.outcome),
  };
  if (repeats > 1) record.repeats = tries.map((one) => comparable(one.outcome));
  return record;
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

async function regrade(path) {
  const prior = JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
  const byId = new Map(prior.records.map((record) => [record.id, record]));
  const missing = allCases.filter((testCase) => !byId.has(testCase.id));
  if (missing.length > 0) {
    console.error(`${path} has no record for ${missing.length} of these cases, so a regrade would be partial.`);
    process.exit(1);
  }
  return allCases.map((testCase) => {
    const saved = byId.get(testCase.id);
    const labels = profile.labels(testCase);
    return { id: testCase.id, note: testCase.note, labels, outcome: saved.outcome, attempts: saved.attempts, ...profile.grade(testCase, labels, saved.outcome) };
  });
}

const startedAt = Date.now();
const records = regradeFrom === undefined ? await inPool(allCases, concurrency, runCase) : await regrade(regradeFrom);
if (records.length > 0 && records.every((r) => r.outcome.error?.reason === "network")) {
  console.error(`No judge answered: ${records[0].outcome.error.detail}`);
  process.exit(1);
}
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
// Every repeat is paid for, so the cost of a run counts all of them and not just the graded one.
const inputTokens = tokensSpent;
const models = [...new Set(records.map((r) => r.outcome.judge))];

const lines = [];
const push = (line) => lines.push(line);
push(`JDE eval, ${decision}, ${setLabel}`);
push(`${records.length} cases, ${allGrades.length} graded questions, answered by ${models.join(", ")}`);
push(
  regradeFrom === undefined
    ? `${labelsRead.read} of ${labelsRead.total} verdict labels read before the first call`
    : `regraded from ${regradeFrom}: no judgment was asked for again`,
);
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
// ---------------------------------------------------------------------------
// Stability. Not accuracy: whether the same question asked twice comes back the same.
// ---------------------------------------------------------------------------

const ACTION_FLOOR = 0.7;
let stability = null;
const repeated = records.filter((record) => Array.isArray(record.repeats) && record.repeats.length > 1);
if (repeated.length > 0) {
  let questionPairs = 0;
  let questionFlips = 0;
  let caseFlips = 0;
  let verdictFlips = 0;
  let casesStable = 0;
  let verdictsStable = 0;
  let spreadTotal = 0;
  let spreadCount = 0;
  let spreadMax = 0;
  let crossedFloor = 0;

  for (const record of repeated) {
    const [first, second] = record.repeats;
    const ids = [...new Set(record.repeats.flatMap((one) => Object.keys(one.answers)))];
    let flipped = false;
    for (const id of ids) {
      questionPairs += 1;
      if (first.answers[id] !== second.answers[id]) {
        questionFlips += 1;
        flipped = true;
      }
      const seen = record.repeats.map((one) => one.confidence[id]).filter((value) => typeof value === "number");
      if (seen.length > 1) {
        const spread = Math.max(...seen) - Math.min(...seen);
        spreadTotal += spread;
        spreadCount += 1;
        spreadMax = Math.max(spreadMax, spread);
        // The band floor is what an action turns on, so an answer that never changes its mind but
        // wanders across 0.7 changes what code does while looking perfectly stable.
        if (Math.min(...seen) < ACTION_FLOOR && Math.max(...seen) >= ACTION_FLOOR) crossedFloor += 1;
      }
    }
    if (flipped) caseFlips += 1;
    if (first.verdict !== second.verdict) verdictFlips += 1;
    const sameAnswers = record.repeats.every((one) => JSON.stringify(one.answers) === JSON.stringify(first.answers));
    if (sameAnswers) casesStable += 1;
    if (record.repeats.every((one) => one.verdict === first.verdict)) verdictsStable += 1;
  }

  stability = {
    repeats,
    cases: repeated.length,
    caseFlips,
    questionPairs,
    questionFlips,
    verdictFlips,
    casesStable,
    verdictsStable,
    meanSpread: spreadCount === 0 ? 0 : spreadTotal / spreadCount,
    maxSpread: spreadMax,
    crossedFloor,
    floor: ACTION_FLOOR,
  };

  push("");
  push(`stability, every case asked ${repeats} times with an identical request`);
  push(`  cases whose answers differ, repeat 0 vs 1    ${padLeft(pct(caseFlips, repeated.length), 7)}  (${caseFlips} of ${repeated.length})`);
  push(`  answers that differ, repeat 0 vs 1           ${padLeft(pct(questionFlips, questionPairs), 7)}  (${questionFlips} of ${questionPairs})`);
  push(`  verdicts that differ, repeat 0 vs 1          ${padLeft(pct(verdictFlips, repeated.length), 7)}  (${verdictFlips} of ${repeated.length})`);
  push(`  cases identical across all ${repeats}             ${padLeft(pct(casesStable, repeated.length), 7)}  (${casesStable} of ${repeated.length})`);
  push(`  verdicts identical across all ${repeats}          ${padLeft(pct(verdictsStable, repeated.length), 7)}  (${verdictsStable} of ${repeated.length})`);
  push(`  mean confidence spread across ${repeats}          ${stability.meanSpread.toFixed(3)}, widest ${spreadMax.toFixed(3)}`);
  push(`  answers that crossed the ${ACTION_FLOOR} action floor  ${padLeft(pct(crossedFloor, spreadCount), 7)}  (${crossedFloor} of ${spreadCount})`);
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
push(judgeName === "jev"
  ? `input tokens ${inputTokens}, about $${((inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS).toFixed(4)} at $${USD_PER_MILLION_INPUT_TOKENS} per million`
  : `input tokens ${inputTokens}, on your own machine`);
const judgmentRows = rowsWritten;
push(
  regradeFrom !== undefined
    ? "no rows appended: a regrade judges nothing"
    : keepLedger
      ? `${judgmentRows} judgment rows appended to ${ledgerPath}, stamped run ${runId}`
      : "judgments discarded: --no-ledger was passed",
);

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
      summary: {
        decision,
        set: setLabel,
        cases: records.length,
        questions: { correct: allGrades.filter((g) => g.correct).length, total: allGrades.length },
        verdicts: { correct: verdictsCorrect, total: scoredVerdicts.length },
        failures: failed.length,
        stability,
        inputTokens,
        costUsd: (inputTokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS,
        ledgerRows: keepLedger ? judgmentRows : 0,
        ledgerPath: keepLedger ? ledgerPath : null,
        runId,
        models,
      },
      report,
      records,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\nraw output written to ${outPath}`);
