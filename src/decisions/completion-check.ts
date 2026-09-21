import { ask } from "../index.ts";
import type { AskOptions } from "../index.ts";
import type { Answers, DecisionContext, LedgerRow, NoulQuestion, Questions } from "../types.ts";

/**
 * The completion check: did the agent actually do the work.
 *
 * The shape is the point. A task is broken into its parts in code, each part is judged on its own,
 * and code decides what the set of parts adds up to. Nothing is asked to count, to order or to
 * compare, because that is where this judge is weakest and where code is exact.
 *
 * Three kinds of part, and only two of them reach a model:
 *
 * - `file` parts are a fact. The path was written, or it was not, and it was not empty. Code knows
 *   that from the receipts, so no model is asked and no confidence is involved.
 * - `action` parts are judged against the receipts alone, never against what the agent said it did.
 * - `reply` parts are judged against the claimed result, because a recommendation that was asked
 *   for is delivered by saying it, and leaves no receipt at all.
 *
 * The wording below is the artefact. It was tuned against one case set and then measured against a
 * blind set written by someone who had not seen it, and it is copied here rather than improved.
 * Rewording one clause silently invalidates both measurements, so a tidy-up here is a new
 * measurement, not a cleanup.
 */

export const COMPLETION_DECISION = "completion-check";

/** A part is carried out at this confidence or better. Below it, the part did not happen. */
export const COMPLETION_PART_FLOOR = 0.7;

/** A claimed result that restates the task is not a report of work, whatever else it says. */
export const COMPLETION_ECHO_FLOOR = 0.7;

/** A part the claim names, judged this far below the line, is an overclaim rather than a miss. */
export const COMPLETION_OVERCLAIM_FLOOR = 0.3;

export interface FilePart {
  readonly kind: "file";
  readonly text: string;
  readonly path: string;
}

export interface ActionPart {
  readonly kind: "action";
  readonly text: string;
}

export interface ReplyPart {
  readonly kind: "reply";
  readonly text: string;
}

export type TaskPart = FilePart | ActionPart | ReplyPart;

export interface ToolCallReceipt {
  readonly name: string;
  readonly count: number;
}

export interface FileWrittenReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly first_line?: string;
}

export interface Receipts {
  readonly tool_calls?: readonly ToolCallReceipt[];
  readonly files_written?: readonly FileWrittenReceipt[];
  readonly searches?: number;
  readonly pages_fetched?: number;
  readonly transcript_entries?: number;
  readonly elapsed_s?: number;
}

/** Exactly what the judge is given, and nothing else. */
export interface CompletionState {
  readonly task: string;
  readonly task_parts: readonly TaskPart[];
  readonly claimed_result: string;
  readonly receipts: Receipts;
}

export interface CompletionCheckInput extends CompletionState {
  /** Indices of the parts the claimed result says were done, gathered in code by the caller. */
  readonly claimed_parts?: readonly number[];
  readonly context?: DecisionContext;
}

export interface PartOutcome {
  readonly index: number;
  readonly kind: TaskPart["kind"];
  readonly passes: boolean;
  /** Absent on a file part, which no model judged. */
  readonly noul?: number;
  readonly evidence?: string;
}

export type CompletionVerdict = "done" | "partial" | "not_done";

export interface CompletionOutcome {
  /** Null when the judge did not answer: an unjudged task is not a failed one. */
  readonly verdict: CompletionVerdict | null;
  readonly parts: readonly PartOutcome[];
  readonly result_is_echo: { readonly value: boolean; readonly noul: number } | null;
  /** Present only when the caller passed claimed_parts. */
  readonly overclaim?: { readonly parts: readonly number[]; readonly any: boolean };
  readonly action: string;
  readonly answers: Answers;
  readonly decisions: readonly LedgerRow[];
  readonly confidence: number | null;
  readonly band: string | null;
  readonly judge: string;
  readonly latencyMs: number;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly error?: { readonly reason: string; readonly detail: string };
}

export const RESULT_IS_ECHO_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Is `claimed_result` a restatement of `task` rather than a report of an outcome?",
  criteria: {
    true: "`claimed_result` repeats the task's own words or its instructions back, with no outcome of its own",
    false: "`claimed_result` reports what happened, what was produced, or what was found",
  },
};

/** One noul per part that a model judges. A file part never gets here. */
export function partQuestion(part: ActionPart | ReplyPart): NoulQuestion {
  if (part.kind === "reply") {
    return {
      type: "noul",
      instructions: `Does \`claimed_result\` contain ${part.text}, stated as an outcome rather than a plan?`,
      criteria: {
        true: "`claimed_result` carries that content itself, written as something already produced or found",
        false: "`claimed_result` does not carry it, or only says it will be produced",
      },
    };
  }
  return {
    type: "noul",
    instructions: `Do \`receipts\` show that this part was carried out: ${part.text}? Count a file written, a search run, a page fetched, or a tool call that produces it; do not count \`claimed_result\` saying so.`,
    criteria: {
      true: "`receipts` carry a file, a search, a fetched page or a tool call that carries out this part",
      false: "nothing in `receipts` carries out this part, whatever `claimed_result` says about it",
    },
  };
}

export function partQuestionId(index: number): string {
  return `part_${index}_done`;
}

/**
 * The question set for one task. The echo question comes first and the parts follow in order, the
 * order they were measured in.
 */
export function completionQuestions(parts: readonly TaskPart[]): Questions {
  const questions: Record<string, NoulQuestion> = { result_is_echo: RESULT_IS_ECHO_QUESTION };
  parts.forEach((part, index) => {
    if (part.kind === "file") return;
    questions[partQuestionId(index)] = partQuestion(part);
  });
  return questions;
}

/** A file part is code's alone: the exact path, written, and not empty. */
export function filePartPasses(part: FilePart, receipts: Receipts): boolean {
  return (receipts.files_written ?? []).some((written) => written.path === part.path && written.bytes > 0);
}

/**
 * What the parts add up to. A task whose parts all hold is done, one where none hold is not done,
 * and anything between is partial. A one part task therefore can never be partial, which is the
 * property that keeps "half of one thing" from being a verdict.
 */
export function completionVerdict(outcomes: readonly PartOutcome[]): CompletionVerdict {
  const passed = outcomes.filter((outcome) => outcome.passes).length;
  if (passed === outcomes.length) return "done";
  if (passed === 0) return "not_done";
  return "partial";
}

export function partOutcomes(
  parts: readonly TaskPart[],
  receipts: Receipts,
  answers: Answers,
): readonly PartOutcome[] {
  return parts.map((part, index) => {
    if (part.kind === "file") {
      const passes = filePartPasses(part, receipts);
      return { index, kind: part.kind, passes, evidence: passes ? "file written" : "no such file" };
    }
    const answer = answers[partQuestionId(index)];
    const noul = answer !== undefined && answer.type === "noul" ? answer.noul : 0;
    return { index, kind: part.kind, passes: noul >= COMPLETION_PART_FLOOR, noul };
  });
}

/** Parts the claim named that the receipts do not carry. Counted in code, never asked. */
export function overclaimedParts(
  outcomes: readonly PartOutcome[],
  claimedParts: readonly number[],
): readonly number[] {
  return claimedParts.filter((index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) return false;
    if (outcome.kind === "file") return !outcome.passes;
    return (outcome.noul ?? 0) < COMPLETION_OVERCLAIM_FLOOR;
  });
}

/**
 * Runs the check. The receipts are gathered by the caller from the run record, so the state never
 * takes the agent's word for what it did.
 *
 * On a judge that does not answer, the verdict is null and the action is the policy's fallback.
 * That is deliberate: a task nobody could judge is not a task that failed, and treating it as one
 * would turn a judge outage into a wave of redispatches.
 */
export async function completionCheck(
  input: CompletionCheckInput,
  options: AskOptions = {},
): Promise<CompletionOutcome> {
  const parts = input.task_parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("a completion check needs at least one task part");
  }

  const state: CompletionState = {
    task: input.task,
    task_parts: parts,
    claimed_result: input.claimed_result,
    receipts: input.receipts,
  };

  const outcome = await ask(
    {
      decision: COMPLETION_DECISION,
      state,
      questions: completionQuestions(parts),
      ...(input.context !== undefined ? { context: input.context } : {}),
    },
    options,
  );

  const base = {
    action: outcome.action,
    answers: outcome.answers,
    decisions: outcome.decisions,
    confidence: outcome.confidence,
    band: outcome.band,
    judge: outcome.judge,
    latencyMs: outcome.latencyMs,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  };

  if (outcome.error !== undefined) {
    return {
      ...base,
      verdict: null,
      parts: [],
      result_is_echo: null,
      error: { reason: outcome.error.reason, detail: outcome.error.detail },
    };
  }

  const outcomes = partOutcomes(parts, input.receipts, outcome.answers);
  const echoAnswer = outcome.answers.result_is_echo;
  const echoNoul = echoAnswer !== undefined && echoAnswer.type === "noul" ? echoAnswer.noul : 0;

  const result: CompletionOutcome = {
    ...base,
    verdict: completionVerdict(outcomes),
    parts: outcomes,
    result_is_echo: { value: echoNoul >= COMPLETION_ECHO_FLOOR, noul: echoNoul },
  };

  if (input.claimed_parts === undefined) return result;
  const overclaimed = overclaimedParts(outcomes, input.claimed_parts);
  return { ...result, overclaim: { parts: overclaimed, any: overclaimed.length > 0 } };
}
