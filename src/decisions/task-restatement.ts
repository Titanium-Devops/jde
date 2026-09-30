import { ask } from "../index.ts";
import type { AskOptions } from "../index.ts";
import { isBottomBand } from "../policy.ts";
import { extractTaskParts } from "../parts.ts";
import type { ExtractedPart } from "../parts.ts";
import type { Answers, DecisionContext, LedgerRow, NoulQuestion, Questions } from "../types.ts";

/**
 * The task restatement check: before the work starts, did the bot read the request.
 *
 * The bot writes the task back in its own words and this decides whether that restatement shows
 * it understood the request. Three things have to hold, and they are three different questions
 * rather than one:
 *
 * - **all of it.** Every part of the request is in the restatement, with the same meaning. One
 *   yes-or-no per part, and the part is the only thing that question is about.
 * - **only it.** The restatement does not require something the request never asked for. One
 *   yes-or-no, once.
 * - **not by copying.** A restatement that repeats the request back shows no reading at all. One
 *   yes-or-no, once, and only when a ratio in code has not already settled it.
 *
 * The shape is the completion check's, for the same reason: a question that covers one part is
 * answered against one short piece of text, and a question that covers a whole task is answered
 * against a whole task. Nothing here is asked to count parts, to compare answers, or to say what
 * the set of them adds up to. That is all below, in code.
 *
 * Unlike the completion check, every part reaches the judge. There is no receipt to check a part
 * against at this point in a turn: the restatement is prose and nothing has run yet, so whether a
 * file part is covered is a question about what the restatement says, not a fact about a
 * filesystem. The one fact code owns here is the copying, because character overlap is arithmetic.
 *
 * Field names are the spec's and the case sets': `taskParts`, `addedRequirement`, `parrot`. The
 * completion check next door uses snake_case because its own state and case sets do. Neither was
 * changed to match the other, and the mapping between the extractor's `part_0` ids and the case
 * sets' `p1` keys is `casePartId()` and `partIndexOf()` below.
 *
 * The wording of the three questions is the artefact. It was written once, measured once against a
 * blind set written by an author who had not seen it, and is copied here rather than improved.
 * Rewording a clause invalidates that measurement, so a tidy-up here is a new measurement.
 *
 * ## Two things the questions do not say, and the definition does
 *
 * The blind run found one place where an honest judge and an honest case author read the same
 * restatement two different ways, and the criteria as written point one way without insisting. This
 * is the decision's definition rather than its wording, so it is settled here and a case author is
 * told it before writing a set. Neither of these is a licence to reword a question.
 *
 * 1. **A constraint inside a part's own text belongs to that part.** When the restatement
 *    contradicts a constraint the part's text carries, that part is uncovered, even when a sibling
 *    part carries the same constraint and is uncovered too. "Write a week of X posts for the
 *    consumer line", answered with posts for the enterprise audience, is uncovered.
 *
 * 2. **`addedRequirement` is work on top of the request, never work in place of it.** A restatement
 *    that volunteers a second deliverable nobody asked for has added a requirement. A restatement
 *    that proposes doing what the request forbade to the same artifact, publishing replies that
 *    were to be left unposted, closing duplicates that were to be tagged, has not added anything:
 *    it has failed to cover the part that asked for the other thing.
 *
 * `docs/task-restatement-review.md` has the cases behind both, and the one change to this file that
 * is proposed and deliberately not made.
 */

export const RESTATEMENT_DECISION = "task-restatement";

/** A part is covered at this confidence or better. Below it, the restatement did not carry it. */
export const RESTATEMENT_COVERED_FLOOR = 0.7;

/** At this confidence or better, the restatement requires something the request did not. */
export const RESTATEMENT_ADDED_FLOOR = 0.7;

/** At this confidence or better, the restatement is a copy rather than a reading. */
export const RESTATEMENT_PARROT_FLOOR = 0.7;

/**
 * A restatement whose four word runs are this much lifted from the request is a copy, and code
 * says so without asking. Four words in a row repeated exactly is not a coincidence, and at three
 * fifths of them the restatement is the request with a few words moved.
 *
 * The number was read off `similarityRatio()` over a handful of written-by-hand probes, before the
 * blind set was opened and never moved after it. A copy with one phrase changed scored 0.75, a
 * copy with its clauses reordered 0.65, a copy behind "I will" 0.68; a real paraphrase scored 0.07
 * and a paraphrase that kept every noun 0.19. The nearest thing to a borderline case, two clauses
 * of three lifted and the third reworded, scored 0.47 and is left to the judge on purpose: code
 * takes only what it is certain of, because a wrong parrot here escalates a restatement that was
 * fine, while an unnecessary question costs a few tokens and nothing else.
 *
 * Below this the ratio says nothing useful either way. A paraphrase parrot, which says the request
 * back in new words and still shows no reading, scores like any other paraphrase, and that is the
 * case `IS_PARROT_QUESTION` exists for.
 */
export const PARROT_RATIO_FLOOR = 0.6;

/** The run length the similarity ratio counts in. */
export const SHINGLE_WORDS = 4;

/** Revise loops the caller may run before the request goes to a person. */
export const RESTATEMENT_MAX_REVISE_LOOPS = 2;

export interface RestatementPart {
  /** `p1`, `p2` and so on in the case sets. Any stable string a caller already has works. */
  readonly id: string;
  readonly text: string;
  readonly kind?: "file" | "action" | "reply";
  readonly path?: string;
}

/** Exactly what the judge is given, and nothing else. No workspace id, no context, no ids of ours. */
export interface RestatementState {
  readonly task: string;
  readonly taskParts: readonly RestatementPart[];
  readonly restatement: string;
}

export interface RestatementInput {
  readonly task: string;
  /**
   * The parts of the task. Optional: leave it out and `extractTaskParts()` reads them out of
   * `task`. An array of parts, an array of plain strings, or an object keyed by part id are all
   * read; see `normaliseParts()`.
   */
  readonly taskParts?: unknown;
  readonly restatement: string;
  /** How many revise loops have already run for this task. Code's, never asked. */
  readonly loop?: number;
  readonly context?: DecisionContext;
}

export interface PartCoverage {
  readonly id: string;
  readonly index: number;
  readonly text: string;
  readonly covered: boolean;
  readonly noul: number;
}

export type RestatementVerdict = "accept" | "revise" | "escalate";

export interface ParrotOutcome {
  readonly value: boolean;
  /** Null when the ratio settled it and no model was asked. */
  readonly noul: number | null;
  readonly ratio: number;
  readonly by: "code" | "judge";
}

export interface RestatementOutcome {
  /** Null when the judge did not answer: an unjudged restatement is not a failed one. */
  readonly verdict: RestatementVerdict | null;
  readonly parts: readonly PartCoverage[];
  /** The part ids to hand back to the bot on a revise. Empty on an accept. */
  readonly uncovered: readonly string[];
  readonly addedRequirement: { readonly value: boolean; readonly noul: number } | null;
  readonly parrot: ParrotOutcome | null;
  /** The share of the restatement's four word runs that are lifted from the task, for the ledger. */
  readonly similarity: number;
  readonly loop: number;
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

// ---------------------------------------------------------------------------
// Part ids. The extractor numbers from zero and the case sets number from one.
// ---------------------------------------------------------------------------

/** The case sets' id for the part at this index. `part_0` is `p1`. */
export function casePartId(index: number): string {
  return `p${index + 1}`;
}

/** The index a part id names, in either shape. Minus one when it names neither. */
export function partIndexOf(id: string): number {
  const fromCase = /^p(\d+)$/.exec(id);
  if (fromCase) return Number(fromCase[1]) - 1;
  const fromExtractor = /^part_(\d+)$/.exec(id);
  if (fromExtractor) return Number(fromExtractor[1]);
  return -1;
}

/** The extractor's parts, renumbered into the shape this decision and the case sets use. */
export function fromExtractedParts(parts: readonly ExtractedPart[]): readonly RestatementPart[] {
  return parts.map((part, index) => ({
    id: casePartId(index),
    text: part.text,
    kind: part.kind,
    ...(part.kind === "file" ? { path: part.path } : {}),
  }));
}

/**
 * Parts as a caller or a case file happens to hold them, read into one shape. An array of parts, an
 * array of plain strings, or an object keyed by part id are all accepted, and an entry that already
 * carries an id keeps it. This reads what is there rather than asking a case set to be rewritten.
 */
export function normaliseParts(input: unknown): readonly RestatementPart[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(input)
    ? input.map((value) => [undefined, value] as [string | undefined, unknown])
    : typeof input === "object" && input !== null
      ? Object.entries(input as Record<string, unknown>)
      : [];

  return entries.map(([key, value], index) => {
    const given = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const id = typeof given.id === "string" && given.id.length > 0 ? given.id : (key ?? casePartId(index));
    const text = typeof value === "string"
      ? value
      : typeof given.text === "string"
        ? given.text
        : typeof given.path === "string"
          ? given.path
          : "";
    if (text.trim().length === 0) {
      throw new TypeError(`task part "${id}" has no text, so there is nothing to ask about it`);
    }
    const kind = given.kind === "file" || given.kind === "action" || given.kind === "reply" ? given.kind : undefined;
    return {
      id,
      text: text.trim(),
      ...(kind === undefined ? {} : { kind }),
      ...(typeof given.path === "string" ? { path: given.path } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------

/** What one coverage question is about: the part's own words, and its path when it has one. */
export function partSubject(part: RestatementPart): string {
  if (part.path !== undefined && part.path.length > 0 && !part.text.includes(part.path)) {
    return `${part.text} (at ${part.path})`;
  }
  return part.text;
}

/** One yes-or-no per part. The judge reads the restatement and this one part, and nothing else. */
export function coverageQuestion(part: RestatementPart): NoulQuestion {
  return {
    type: "noul",
    instructions: `Does \`restatement\` carry this part of the request, with the same meaning: ${partSubject(part)}?`,
    criteria: {
      true: "`restatement` says this part, in any words and in any position, and means the same thing by it",
      false: "`restatement` leaves this part out, or changes what it asks for: a different subject, a different target, a different limit, or the opposite intent",
    },
    passingAnswer: "true",
  };
}

/**
 * A confident yes is the failure here: the restatement invented work. So "no, everything it
 * requires was asked for" is the answer that passes, and `passingAnswer` says which one that is.
 */
export const ADDS_REQUIREMENT_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Does `restatement` require something that `task` does not ask for?",
  criteria: {
    true: "`restatement` names a deliverable, a step, a limit or an audience that is not in `task` and that nothing in `task` asks for",
    false: "everything `restatement` requires is asked for in `task`. Rewording a part, reordering the parts, leaving one out, or getting one wrong is not an added requirement.",
  },
  passingAnswer: "false",
};

/** The other one a confident yes fails: a copy shows no reading, so "no" is the pass. */
export const IS_PARROT_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Is `restatement` a copy of `task` rather than a restatement of it?",
  criteria: {
    true: "`restatement` repeats `task`'s own sentences, changed only by dropping a word, moving a clause, or swapping a word for a synonym",
    false: "`restatement` is written in the writer's own sentences, even where names, paths and numbers from `task` have to stay the same",
  },
  passingAnswer: "false",
};

export function coverageQuestionId(partId: string): string {
  return `part_${partId}_covered`;
}

export const ADDS_REQUIREMENT_ID = "adds_requirement";
export const IS_PARROT_ID = "is_parrot";

/**
 * The question set for one restatement: the parts in the order they were written, then the two
 * whole-restatement questions. The parrot question is left out when the ratio already settled it,
 * the same way the completion check never asks a model whether a file exists.
 */
export function restatementQuestions(
  parts: readonly RestatementPart[],
  askParrot: boolean,
): Questions {
  const questions: Record<string, NoulQuestion> = {};
  for (const part of parts) questions[coverageQuestionId(part.id)] = coverageQuestion(part);
  questions[ADDS_REQUIREMENT_ID] = ADDS_REQUIREMENT_QUESTION;
  if (askParrot) questions[IS_PARROT_ID] = IS_PARROT_QUESTION;
  return questions;
}

// ---------------------------------------------------------------------------
// What code owns.
// ---------------------------------------------------------------------------

/** The words a ratio counts, lowercased, with the punctuation and the path separators dropped. */
export function ratioWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * The share of the restatement's four word runs that appear, exactly, in the task.
 *
 * A verbatim copy scores 1. A paraphrase that keeps the same nouns scores near zero, because it
 * shares the words and not the runs. A copy with its clauses reordered still scores high, which is
 * the point: moving a sentence is not reading it.
 *
 * The run length is the task's business, not the restatement's. A two word task is compared in two
 * word runs, so a short request still has a ratio; but a restatement too short to hold one run of
 * the task scores zero rather than being compared word by word, because single word overlap is not
 * copying and a one word answer to a long request is a restatement that covered nothing.
 */
export function similarityRatio(task: string, restatement: string): number {
  const left = ratioWords(task);
  const right = ratioWords(restatement);
  if (left.length === 0 || right.length === 0) return 0;
  const run = Math.min(SHINGLE_WORDS, left.length);
  if (right.length < run) return 0;
  const inTask = new Set<string>();
  for (let at = 0; at + run <= left.length; at += 1) inTask.add(left.slice(at, at + run).join(" "));
  let found = 0;
  let total = 0;
  for (let at = 0; at + run <= right.length; at += 1) {
    total += 1;
    if (inTask.has(right.slice(at, at + run).join(" "))) found += 1;
  }
  return total === 0 ? 0 : found / total;
}

/** Whether the ratio alone says this is a copy, in which case no model is asked about it. */
export function ratioSaysParrot(ratio: number): boolean {
  return ratio >= PARROT_RATIO_FLOOR;
}

/**
 * The band a policy puts the bottom of its range in, read off the label `bandFor()` built from the
 * policy's own boundaries. It lives in `policy.ts` now that the ask gate reads it too, and is
 * re-exported here because this decision published the name first.
 */
export { isBottomBand };

export interface VerdictInput {
  readonly parts: readonly PartCoverage[];
  readonly addedRequirement: boolean;
  readonly parrot: boolean;
  readonly bottomBand: boolean;
  readonly loop: number;
}

/**
 * What the answers add up to, decided here and never by the judge.
 *
 * A copy goes to a person: a bot that hands the request back has not started reading, and another
 * loop asking it to try again is the same call twice. An answer the judge was genuinely unsure
 * about goes to a person too, which is what the bottom band is for. What is left is a restatement
 * that either covered everything and added nothing, or did not, and that one is worth a revise
 * until the loop budget runs out.
 */
export function restatementVerdict(input: VerdictInput): RestatementVerdict {
  if (input.parrot) return "escalate";
  if (input.bottomBand) return "escalate";
  const missed = input.parts.some((part) => !part.covered);
  if (!missed && !input.addedRequirement) return "accept";
  return input.loop >= RESTATEMENT_MAX_REVISE_LOOPS ? "escalate" : "revise";
}

export function partCoverage(parts: readonly RestatementPart[], answers: Answers): readonly PartCoverage[] {
  return parts.map((part, index) => {
    const answer = answers[coverageQuestionId(part.id)];
    const noul = answer !== undefined && answer.type === "noul" ? answer.noul : 0;
    return { id: part.id, index, text: part.text, covered: noul >= RESTATEMENT_COVERED_FLOOR, noul };
  });
}

// ---------------------------------------------------------------------------
// The call.
// ---------------------------------------------------------------------------

/**
 * Runs the check. One call, one deadline, one fallback.
 *
 * On a judge that does not answer the verdict is null and the action is the policy's fallback,
 * which is to proceed. That is deliberate and it is the spec's: a customer's job must not wait on
 * a judge, and a restatement nobody could judge is not a restatement that failed. The ledger says
 * the decision was unjudged, and the turn goes on exactly as a turn with no judge would.
 */
export async function taskRestatement(
  input: RestatementInput,
  options: AskOptions = {},
): Promise<RestatementOutcome> {
  const given = input.taskParts;
  const parts: readonly RestatementPart[] = given === undefined || given === null
    ? fromExtractedParts(extractTaskParts(input.task))
    : normaliseParts(given);
  if (parts.length === 0) {
    throw new TypeError(
      given === undefined || given === null
        ? "a restatement check needs a task with at least one part in it"
        : "a restatement check needs at least one task part",
    );
  }

  const similarity = similarityRatio(input.task, input.restatement);
  const settledByCode = ratioSaysParrot(similarity);
  const loop = input.loop ?? 0;

  const state: RestatementState = {
    task: input.task,
    taskParts: parts,
    restatement: input.restatement,
  };

  const outcome = await ask(
    {
      decision: RESTATEMENT_DECISION,
      state,
      questions: restatementQuestions(parts, !settledByCode),
      ...(input.context !== undefined ? { context: input.context } : {}),
    },
    options,
  );

  const base = {
    similarity,
    loop,
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
      uncovered: [],
      addedRequirement: null,
      parrot: null,
      error: { reason: outcome.error.reason, detail: outcome.error.detail },
    };
  }

  const coverage = partCoverage(parts, outcome.answers);
  const addedAnswer = outcome.answers[ADDS_REQUIREMENT_ID];
  const addedNoul = addedAnswer !== undefined && addedAnswer.type === "noul" ? addedAnswer.noul : 0;
  const addedRequirement = { value: addedNoul >= RESTATEMENT_ADDED_FLOOR, noul: addedNoul };

  const parrotAnswer = outcome.answers[IS_PARROT_ID];
  const parrotNoul = parrotAnswer !== undefined && parrotAnswer.type === "noul" ? parrotAnswer.noul : 0;
  const parrot: ParrotOutcome = settledByCode
    ? { value: true, noul: null, ratio: similarity, by: "code" }
    : { value: parrotNoul >= RESTATEMENT_PARROT_FLOOR, noul: parrotNoul, ratio: similarity, by: "judge" };

  return {
    ...base,
    verdict: restatementVerdict({
      parts: coverage,
      addedRequirement: addedRequirement.value,
      parrot: parrot.value,
      // The certainty band, not the confidence one. This asks whether the judge knew, and a
      // confidence now says whether the restatement passed: a part confidently missed is a low
      // confidence and a high certainty, and it belongs in the revise loop rather than with a
      // person. Only a judge that could not decide escalates here, which is what it always meant.
      bottomBand: isBottomBand(outcome.certaintyBand),
      loop,
    }),
    parts: coverage,
    uncovered: coverage.filter((part) => !part.covered).map((part) => part.id),
    addedRequirement,
    parrot,
  };
}
