import { fileLedger } from "./ledger.ts";
import { DEFAULT_JUDGE, judgeNamed } from "./judge/index.ts";
import {
  aggregateFloor,
  answerText,
  bandFor,
  certaintyOf,
  confidenceOf,
  loadPolicyBook,
  policyFor,
  resolveAggregate,
  validatePolicyEntry,
} from "./policy.ts";
import { JudgeError } from "./types.ts";
import type {
  Answer,
  Answers,
  AskInput,
  Failure,
  Judge,
  JudgeReply,
  Ledger,
  LedgerRow,
  Outcome,
  PolicyBook,
  PolicyEntry,
  Question,
  Questions,
  RunKind,
} from "./types.ts";

export * from "./types.ts";
export {
  codeJudge,
  DEFAULT_JUDGE,
  jebJudge,
  JEB_API_KEY_ENV,
  JEB_ENDPOINT,
  JEB_ENDPOINT_ENV,
  JEB_MODEL,
  JEB_MODEL_ENV,
  JEB_START_HINT,
  jevJudge,
  judgeNamed,
  JEV_ENDPOINT,
  JEV_MODEL,
  questionsForWire,
  systemOneJudge,
  TYPESAFE_API_KEY_ENV,
} from "./judge/index.ts";
export type { CodeAnswer, CodeJudgeOptions, JebJudgeOptions, JevJudgeOptions, SystemOneJudgeOptions } from "./judge/index.ts";
export {
  fileLedger,
  memoryLedger,
  nullLedger,
  markReviewed,
  markRight,
  markWrong,
  readLedger,
  taggedLedger,
  defaultLedgerPath,
} from "./ledger.ts";
export type { MemoryLedger, ReviewOptions } from "./ledger.ts";
export * from "./review.ts";
export {
  aggregateFloor,
  answerText,
  bandFor,
  certaintyOf,
  confidenceOf,
  defaultPolicyPath,
  forgetPolicyCache,
  isBottomBand,
  loadPolicyBook,
  passingAnswerOf,
  policyFor,
  validatePolicyEntry,
} from "./policy.ts";
export type { Score } from "./policy.ts";
export * from "./decisions/ask-gate.ts";
export * from "./decisions/completion-check.ts";
export * from "./decisions/task-restatement.ts";
export * from "./parts.ts";

export interface AskOptions {
  /** Overrides the judge the policy names. A test passes its own; production passes nothing. */
  readonly judge?: Judge;
  /** A policy book in memory, instead of the file. */
  readonly policy?: PolicyBook;
  /** One entry, when the caller already holds it. Validated the same way. */
  readonly policyEntry?: PolicyEntry;
  readonly policyPath?: string;
  readonly ledger?: Ledger;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * Ask one decision's questions, band the answers, record them, and hand back what code should do.
 *
 * The order matters and is the whole design. The policy is loaded first, so a decision with no
 * band for the bottom or no fallback fails here rather than at the moment it is unsure. The judge
 * is then handed the state, the questions and a deadline, and nothing else: not the aggregate
 * rule, not the bands, not the context. The bands and the aggregate are applied afterwards, in
 * code, to answers that were given without knowing what would be done with them.
 *
 * It does not throw for anything a judge does. A timeout, a refusal, an answer that cannot be read:
 * each one returns the policy's on_error action with the failure recorded, so a judge that is down
 * leaves the agent doing exactly what an agent without a judge would do. It throws only for a
 * policy or a call that is wrong in itself, which is a programming error and not a judgment.
 */
export async function ask<State = unknown>(input: AskInput<State>, options: AskOptions = {}): Promise<Outcome> {
  const { decision, state, questions, context } = input;
  if (typeof decision !== "string" || decision.length === 0) {
    throw new TypeError("ask() needs a decision name: it chooses the policy entry and labels every row");
  }
  const questionIds = Object.keys(questions ?? {});
  if (questionIds.length === 0) {
    throw new TypeError(`decision "${decision}" was asked with no questions`);
  }

  const entry = resolvePolicy(decision, options);
  const aggregate = resolveAggregate(entry.aggregate);
  if (aggregate === undefined) {
    throw new Error(`policy entry "${decision}" names an aggregate rule this build does not have: ${entry.aggregate}`);
  }
  const judge = options.judge ?? judgeNamed(entry.judge ?? DEFAULT_JUDGE);
  const ledger = options.ledger ?? fileLedger();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), entry.timeout_ms);
  const startedAt = Date.now();
  let reply: JudgeReply | undefined;
  let failure: Failure | undefined;
  try {
    reply = await judge.ask(state, questions, controller.signal);
  } catch (error) {
    failure = asFailure(error, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - startedAt;

  let answers: Answers = {};
  if (failure === undefined && reply !== undefined) {
    const checked = checkAnswers(questions, reply.answers);
    if ("problem" in checked) {
      failure = { reason: "malformed", detail: checked.problem };
    } else {
      answers = checked.answers;
    }
  }

  const judgeId = reply?.model ?? judge.id;
  const rows: LedgerRow[] = [];

  if (failure !== undefined) {
    const band = bandFor(0, entry.bands);
    const row: LedgerRow = {
      id: newId(),
      ts: now().toISOString(),
      decision,
      question: AGGREGATE_ROW,
      answer: "none",
      confidence: 0,
      band: band.label,
      action: entry.on_error,
      judge: judgeId,
      latencyMs,
      ...contextFields(context),
      error: failure.reason,
    };
    rows.push(row);
    await ledger.append(row);
    return {
      decision,
      answers: {},
      action: entry.on_error,
      confidence: null,
      band: null,
      certainty: null,
      certaintyBand: null,
      decisions: rows,
      judge: judgeId,
      latencyMs,
      error: failure,
    };
  }

  for (const id of questionIds) {
    const answer = answers[id] as Answer;
    const confidence = confidenceOf(answer, questions[id]);
    const band = bandFor(confidence, entry.bands);
    const row: LedgerRow = {
      id: newId(),
      ts: now().toISOString(),
      decision,
      question: id,
      answer: answerText(answer),
      confidence,
      band: band.label,
      action: band.band.action,
      judge: judgeId,
      latencyMs,
      ...contextFields(context),
    };
    rows.push(row);
    await ledger.append(row);
  }

  // Two aggregates over the same answers and the same rule, differing only in what one answer is
  // worth. The bands and the action are read off the pass confidence, which is the one that says
  // whether this went well. The certainty is carried beside it for the callers whose verdict turns
  // on the judge having not known, which a pass confidence cannot tell apart from a confident no.
  const aggregateConfidence = aggregate(answers, (answer, id) => confidenceOf(answer, questions[id]));
  const aggregateBand = bandFor(aggregateConfidence, entry.bands);
  const aggregateCertainty = aggregate(answers, certaintyOf);
  const certaintyBand = bandFor(aggregateCertainty, entry.bands);
  const aggregateRow: LedgerRow = {
    id: newId(),
    ts: now().toISOString(),
    decision,
    question: AGGREGATE_ROW,
    answer: entry.aggregate,
    confidence: aggregateConfidence,
    band: aggregateBand.label,
    action: aggregateBand.band.action,
    judge: judgeId,
    latencyMs,
    ...contextFields(context),
  };
  rows.push(aggregateRow);
  await ledger.append(aggregateRow);

  return {
    decision,
    answers,
    action: aggregateBand.band.action,
    confidence: aggregateConfidence,
    band: aggregateBand.label,
    certainty: aggregateCertainty,
    certaintyBand: certaintyBand.label,
    decisions: rows,
    judge: judgeId,
    latencyMs,
    ...(reply?.inputTokens === undefined
      ? {}
      : { usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens ?? 0 } }),
  };
}

/**
 * The decision's own row, written after the per-question rows. DESIGN.md's ledger is one line per
 * question; this line is the one thing those lines do not say, which is what code did once it had
 * them all. On a decision that never got an answer it is the only row there is, and without it a
 * fallback would leave no trace at all.
 */
export const AGGREGATE_ROW = "aggregate";

/** The floor a decision's aggregate rule sets, for a caller that wants to report it. */
export function floorFor(entry: PolicyEntry): number | undefined {
  return aggregateFloor(entry.aggregate);
}

function resolvePolicy(decision: string, options: AskOptions): PolicyEntry {
  if (options.policyEntry !== undefined) {
    validatePolicyEntry(decision, options.policyEntry);
    return options.policyEntry;
  }
  const book = options.policy ?? loadPolicyBook(options.policyPath);
  const entry = policyFor(decision, book);
  if (options.policy !== undefined) validatePolicyEntry(decision, entry);
  return entry;
}

function contextFields(context: AskInput["context"]): {
  agentId?: string;
  turnId?: string;
  runKind?: RunKind;
  runId?: string;
} {
  const fields: { agentId?: string; turnId?: string; runKind?: RunKind; runId?: string } = {};
  if (context?.agentId !== undefined) fields.agentId = context.agentId;
  if (context?.turnId !== undefined) fields.turnId = context.turnId;
  if (context?.runKind !== undefined) fields.runKind = context.runKind;
  if (context?.runId !== undefined) fields.runId = context.runId;
  return fields;
}

function asFailure(error: unknown, signal: AbortSignal): Failure {
  if (error instanceof JudgeError) return { reason: error.reason, detail: error.detail };
  if (signal.aborted) return { reason: "timeout", detail: "no answer before the deadline" };
  const name = (error as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return { reason: "timeout", detail: "no answer before the deadline" };
  }
  return { reason: "unknown", detail: String((error as Error)?.message ?? error) };
}

/**
 * Every question asked has to come back answered, in the type it was asked in. A set that is
 * missing one is not a partial success: the aggregate would be computed over a hole, and a
 * decision quietly made on fewer questions than it asked is worse than no decision at all.
 */
function checkAnswers(questions: Questions, given: Answers): { answers: Answers } | { problem: string } {
  if (typeof given !== "object" || given === null) return { problem: "the judge returned no answers" };
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = given[id];
    if (answer === undefined) return { problem: `no answer came back for "${id}"` };
    if (!matches(question, answer)) {
      return { problem: `the answer to "${id}" is a ${answer.type}, and a ${question.type} was asked` };
    }
    answers[id] = answer;
  }
  return { answers };
}

function matches(question: Question, answer: Answer): boolean {
  return question.type === answer.type;
}
