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
  /** Which judge answers this decision. Only `jev` can be named; a test passes its judge in. */
  readonly judge?: string;
}

export type PolicyBook = Readonly<Record<string, PolicyEntry>>;

/** For the ledger only. Never reaches a judge. */
export interface DecisionContext {
  readonly agentId?: string;
  readonly turnId?: string;
}

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
  /** Present only on the aggregate row of a decision that failed. */
  readonly error?: FailureReason;
}

/** A person marking a row wrong appends this. It never edits the row it points at. */
export interface WrongMarker {
  readonly id: string;
  readonly wrong: true;
  readonly by: string;
  readonly ts: string;
}

export interface Ledger {
  append(row: LedgerRow | WrongMarker): Promise<void>;
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
  /** The aggregate confidence, or null when there is none because nothing was answered. */
  readonly confidence: number | null;
  readonly band: string | null;
  /** What was written to the ledger, in the order it was written. */
  readonly decisions: readonly LedgerRow[];
  readonly judge: string;
  readonly latencyMs: number;
  /** What the judge spent, when it says. Never written to the ledger. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Set when the decision fell back. */
  readonly error?: Failure;
}
