/**
 * The shapes every part of JDE agrees on: what a question is, what an answer is, what a judge
 * is, what a policy says, and what one ledger row looks like.
 *
 * Nothing here reads a file, makes a call or holds a credential.
 */

/** One of a defined set of options. Every option set includes an outcome for "none of these fit". */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Whether a condition holds. The answer is a probability that it does. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
  /**
   * Which answer means the thing being judged is in good order. Defaults to `"true"`, which is
   * what a question phrased as "was this done" wants.
   *
   * It exists because a yes-or-no question does not say, by its type alone, which way is the good
   * way. "Is the result just the task restated?" is answered well by a confident no. Without this
   * field the bands cannot tell a confident pass from a confident failure, and both land in the
   * accepting band, which is exactly what happened before it was added.
   *
   * Three values, because there are three kinds of yes-or-no question:
   *
   * - `"true"` asks whether something holds. A confident no is a failure.
   * - `"false"` asks whether something is wrong. A confident yes is a failure.
   * - `"either"` asks for a fact that code will branch on, where both answers are fine and only
   *   the judge not knowing is a problem. Its confidence is how sure the judge was, either way.
   *
   * It is a property of the question, not of the answer, and a judge must never see it: it names
   * the answer we consider good, on a question asked to find out whether the judge can tell. That
   * is enforced by `questionsForWire()`, which builds the request body from a whitelist of the
   * three fields a judge reasons from, and not by anybody remembering. It shipped on the wire for
   * one commit before that existed.
   */
  readonly passingAnswer?: "true" | "false" | "either";
}

/**
 * A degree, over ordered levels. Shipped for completeness of the three primitives; no decision in
 * this package asks one yet, so its wording has never been measured against a case set.
 */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Readonly<Record<string, Question>>;

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly legend?: unknown;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Readonly<Record<string, Answer>>;

/**
 * What a judge hands back. DESIGN.md writes the interface as returning the answers alone; it
 * returns this wrapper instead so the id of the model that actually answered, and the tokens it
 * spent, reach the ledger. `jev-latest` resolves to a pinned version on the far side, and a row
 * that recorded the alias would not say which model made the call.
 */
export interface JudgeReply {
  readonly answers: Answers;
  /** The model that answered, when it differs from the judge's configured id. */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * A judge answers questions about a state. It is handed the state, the questions and a signal,
 * and nothing else: not the aggregate rule, not the bands, not the context, not the decision name.
 */
export interface Judge {
  /** Recorded on every row it produces. */
  readonly id: string;
  ask(state: unknown, questions: Questions, signal: AbortSignal): Promise<JudgeReply>;
}

/** The reasons a judgment can fail to arrive. Each one falls back; none of them throws. */
export type FailureReason =
  | "timeout"
  | "no_key"
  | "http_error"
  | "malformed"
  | "network"
  | "unknown";

export interface Failure {
  readonly reason: FailureReason;
  readonly detail: string;
}

/** A judge failure. Thrown by a judge, caught by ask(), never seen by a caller. */
export class JudgeError extends Error {
  readonly reason: FailureReason;
  readonly detail: string;
  constructor(reason: FailureReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "JudgeError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface Band {
  readonly at_least: number;
  readonly action: string;
}

export interface PolicyEntry {
  readonly bands: readonly Band[];
  readonly aggregate: string;
  readonly on_error: string;
  readonly timeout_ms: number;
  /** Which judge answers this decision: `jeb` (the default, a local Jeb) or `jev` (hosted, opt in). A test passes its judge in. */
  readonly judge?: string;
}

export type PolicyBook = Readonly<Record<string, PolicyEntry>>;

/** For the ledger only. Never reaches a judge. */
export interface DecisionContext {
  readonly agentId?: string;
  readonly turnId?: string;
  /**
   * What kind of traffic this is. Absent means a live decision, made for a real person. A harness
   * sets "eval", and the reader leaves those rows out unless it is asked for them, so a threshold
   * is never set on judgments about cases somebody wrote to be judged.
   */
  readonly runKind?: RunKind;
  /** Which run these rows belong to, so one run can be pulled out of a shared file. */
  readonly runId?: string;
}

export type RunKind = "eval";

/** One line of the ledger. The state is not here, and never will be. */
export interface LedgerRow {
  readonly id: string;
  readonly ts: string;
  readonly decision: string;
  readonly question: string;
  readonly answer: string;
  readonly confidence: number;
  readonly band: string;
  readonly action: string;
  readonly judge: string;
  readonly latencyMs: number;
  readonly agentId?: string;
  readonly turnId?: string;
  /** Present only on a row a harness wrote. A row without it is a live decision. */
  readonly runKind?: RunKind;
  readonly runId?: string;
  /** Present only on the aggregate row of a decision that failed. */
  readonly error?: FailureReason;
}

/**
 * A reviewer's verdict on one row. It never edits the row it points at, and a later marker never
 * deletes an earlier one: both are in the file, and the reader resolves them.
 *
 * `wrong` carries the whole answer, not half of it. `false` means reviewed and right, which is the
 * fact that makes a denominator possible: without it an unmarked row is either correct or never
 * looked at, and those are not the same thing.
 */
export interface ReviewMarker {
  /** The id of the ledger row this is about. */
  readonly id: string;
  readonly wrong: boolean;
  readonly by: string;
  readonly ts: string;
  /** One line on why, for the person reading the row later. Optional. */
  readonly why?: string;
}

/**
 * What `markWrong` writes: a review whose verdict is wrong. Kept as its own name because it is
 * public surface, and every marker written before reviewed-and-right existed has this shape.
 */
export interface WrongMarker extends ReviewMarker {
  readonly wrong: true;
}

export interface Ledger {
  append(row: LedgerRow | ReviewMarker): Promise<void>;
}

export interface AskInput<State = unknown> {
  /** Names the policy entry and every ledger row this call writes. */
  readonly decision: string;
  readonly state: State;
  readonly questions: Questions;
  readonly context?: DecisionContext;
}

export interface Outcome {
  readonly decision: string;
  /** Empty when the judge did not answer. */
  readonly answers: Answers;
  /** What code should do. The band's action, or the policy's on_error. */
  readonly action: string;
  /**
   * The aggregate confidence that this decision passed, or null when there is none because
   * nothing was answered. Every question's answer is read as the probability of its own passing
   * answer first, so a confident "no" to "was part one done" is a low confidence here and not a
   * high one.
   */
  readonly confidence: number | null;
  readonly band: string | null;
  /**
   * The aggregate of how sure the judge was of anything, whichever way it answered, and the band
   * that lands in. Not the same number as `confidence`: a flat "no" is certain and does not pass.
   *
   * It is here for the one thing a pass confidence cannot say, which is that the judge did not
   * know. A caller that sends genuinely unsure judgments to a person reads this; a caller that
   * decides what to do about the answer reads `action`. It is not written to the ledger, because
   * a row's confidence is the number its action was taken on.
   */
  readonly certainty: number | null;
  readonly certaintyBand: string | null;
  /** What was written to the ledger, in the order it was written. */
  readonly decisions: readonly LedgerRow[];
  readonly judge: string;
  readonly latencyMs: number;
  /** What the judge spent, when it says. Never written to the ledger. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Set when the decision fell back. */
  readonly error?: Failure;
}
