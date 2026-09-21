import { ask } from "../index.ts";
import type { AskOptions } from "../index.ts";
import { certaintyOf, isBottomBand } from "../policy.ts";
import type {
  Answers,
  ChoiceQuestion,
  DecisionContext,
  LedgerRow,
  NoulQuestion,
  Questions,
} from "../types.ts";

/**
 * The ask gate: is this question the person's to answer.
 *
 * A bot about to interrupt someone is classified before the message is sent. A question a tool in
 * the bot's own manifest would answer goes back to the bot with the tool named. A question that is
 * genuinely the person's call, or that the bot cannot get at, goes to the person. Everything else
 * goes to the person with a flag on it.
 *
 * The rule this enforces is "if it is runnable, it is not the human's to answer", and the thing it
 * must never do is swallow a question. There is no path below that ends in silence: `suppress` is
 * the only verdict that holds a message back, it is reachable only when four separate conditions
 * all hold, and three of those four are facts in code rather than answers from a model.
 *
 * Three questions, asked in one call:
 *
 * - **choice, once.** Which of runnable, preference or blocked describes how this gets answered,
 *   with an option for none of the three, because a judge forced to pick from a set that does not
 *   contain the answer will pick the nearest wrong one.
 * - **choice, once.** Which tool in the manifest would answer it. The options are the manifest, one
 *   per tool, each with that tool's own one line description as its criterion, plus an option for
 *   no tool at all. Not asked when the manifest is empty, because then there is nothing to pick.
 * - **yes-or-no, once.** Whether the recent tool calls show the bot already trying this question.
 *   Not asked when there are no recent calls, because then the answer is no and code knows it.
 *
 * What code owns, and never asks:
 *
 * - whether the manifest is empty, which alone makes suppression impossible
 * - whether the tool the judge named is actually in the manifest, by exact name
 * - whether that tool already appears in `recentToolCalls`, which is the no second suppression
 *   rule: the bot was told to run it, it ran it, and it is still asking
 * - the verdict, from the raw answers
 *
 * ## One thing the questions do not say, and the definition does
 *
 * The blind run found an honest judge and an honest case author reading `already_tried` two ways.
 * It is a property of the decision rather than of the wording, so it is settled here and a case
 * author is told before writing a set.
 *
 * **Already tried means the same tool, on this question, run and come back without the answer.**
 * Related work does not count. A bot that fetched a vendor's login page and is now asking for the
 * password has not already tried to get the password; a bot that searched Drive for the brand guide
 * and found nothing has already tried the thing it is now asking about. The judge read any recent
 * call on the same subject as an attempt and said true seven times where the author said false.
 *
 * **And one thing the spec and that author disagree about, which is not settled here.** The spec
 * says a runnable question whose tool was already tried goes to the person, so that a retry loop
 * cannot suppress for ever. Every case in the set labelled already tried is a first miss, a wrong
 * path or a zero-result first guess, and its author's note says the bot should simply try again.
 * Both are right about different things: the spec is about a loop and the set is about one attempt,
 * and this code cannot tell them apart because it holds a boolean where it wants a count. See
 * `docs/ask-gate-review.md`.
 *
 * **`action` is not the verdict, and a caller must not read it as one.** The generic layer hands
 * back the band its aggregate pass confidence landed in, and this gate has almost no pass
 * confidence to speak of: two of its three questions are a classification and a pick, and the
 * third is a fact that is fine answered either way. What it wants from the bands is the one thing
 * a pass confidence cannot say, which is that the judge did not know, so it reads `certaintyBand`
 * and works the verdict out from the raw answers. A caller reading `action` gets some backwards.
 */

export const ASK_GATE_DECISION = "ask-gate";

/** Jev's choice cardinality tops out at 255, and one option is spent on "no tool". */
export const ASK_GATE_MAX_TOOLS = 254;

/** At this confidence or better, the recent calls already carried an attempt at this question. */
export const ASK_GATE_TRIED_FLOOR = 0.7;

export type AskKind = "runnable" | "preference" | "blocked" | "none_of_these";

export type AskVerdict = "suppress" | "pass" | "pass_flagged";

export const ASK_KINDS: readonly AskKind[] = ["runnable", "preference", "blocked", "none_of_these"];

export interface ManifestTool {
  readonly name: string;
  /** One line, from the skills panel. Never a full tool schema. */
  readonly description: string;
}

/** Exactly what the judge is given. No workspace id, no context, no tool schemas. */
export interface AskGateState {
  readonly question: string;
  readonly taskSummary?: string;
  readonly toolManifest: readonly ManifestTool[];
  readonly recentToolCalls: unknown;
}

export interface AskGateInput {
  readonly question: string;
  readonly taskSummary?: string;
  /** The bot's enabled skills. Parts with a name and a one line description; see `normaliseManifest()`. */
  readonly toolManifest?: unknown;
  /** What the bot has run lately. Read for names in code, passed whole to the judge. */
  readonly recentToolCalls?: unknown;
  readonly context?: DecisionContext;
}

export interface ToolOutcome {
  /** Null when the judge picked no tool, or named one the manifest does not have. */
  readonly name: string | null;
  readonly chosen: string;
  readonly inManifest: boolean;
  readonly confidence: number;
}

export interface TriedOutcome {
  readonly value: boolean;
  /** What made it true. Null when it is false. */
  readonly by: "code" | "judge" | "both" | null;
  /** Null when no model was asked, because there were no recent calls to ask about. */
  readonly noul: number | null;
  /** The chosen tool's exact name appears in `recentToolCalls`. A fact, never a judgment. */
  readonly inRecentCalls: boolean;
}

export interface AskGateOutcome {
  /** Null when the judge did not answer. An unjudged question is sent, not held. */
  readonly verdict: AskVerdict | null;
  readonly kind: AskKind | null;
  readonly kindConfidence: number;
  /** Null when the manifest was empty and no tool question was asked. */
  readonly tool: ToolOutcome | null;
  readonly alreadyTried: TriedOutcome;
  /** One line for the bot or the person, per the spec. Always set once a verdict exists. */
  readonly reason: string;
  /** The question ids whose confidence is the aggregate, so a reader knows what set the band. */
  readonly weakest: readonly string[];
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

export const QUESTION_KIND_ID = "question_kind";
export const ANSWERING_TOOL_ID = "answering_tool";
export const ALREADY_TRIED_ID = "already_tried";

// ---------------------------------------------------------------------------
// Reading what a caller happens to hold.
// ---------------------------------------------------------------------------

/**
 * The manifest in whatever shape it arrives: parts with a name and a description, bare names, or an
 * object of name to description. A tool with no name is dropped, because an option with no name
 * cannot be chosen or checked; a repeated name is dropped after the first, because two options with
 * one key is one option and a judge picking it means nothing.
 */
export function normaliseManifest(input: unknown): readonly ManifestTool[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(input)
    ? input.map((value) => [undefined, value] as [string | undefined, unknown])
    : typeof input === "object" && input !== null
      ? Object.entries(input as Record<string, unknown>)
      : [];

  const tools: ManifestTool[] = [];
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    const given = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const name = typeof value === "string" && key === undefined
      ? value
      : typeof given.name === "string" && given.name.length > 0
        ? given.name
        : typeof given.tool === "string" && given.tool.length > 0
          ? given.tool
          : (key ?? "");
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const described = typeof value === "string" && key !== undefined
      ? value
      : typeof given.description === "string" && given.description.trim().length > 0
        ? given.description.trim()
        : typeof given.summary === "string" && given.summary.trim().length > 0
          ? given.summary.trim()
          : "";
    tools.push({ name, description: described.length > 0 ? described : `the ${name} tool` });
  }
  return tools;
}

/** The names of what the bot has run lately, for code's exact match. The judge sees the whole thing. */
export function recentToolNames(input: unknown): readonly string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "object" && input !== null
      ? Object.values(input as Record<string, unknown>)
      : [];
  const names: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      names.push(value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const given = value as Record<string, unknown>;
    const name = typeof given.name === "string" ? given.name : typeof given.tool === "string" ? given.tool : undefined;
    if (name !== undefined && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * The option that means no tool fits. Derived rather than fixed, so a manifest that happens to
 * contain a tool called `no_tool` does not quietly lose one of its options to a collision.
 */
export function noToolOption(manifest: readonly ManifestTool[]): string {
  let option = "no_tool";
  while (manifest.some((tool) => tool.name === option)) option = `_${option}`;
  return option;
}

// ---------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------

export const QUESTION_KIND_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions:
    "How does this question get answered? `question` is what the bot is about to send to a person, and `toolManifest` is everything the bot can do for itself.",
  criteria: {
    runnable:
      "a tool in `toolManifest` would produce the answer: it is a fact about a system, a file, an account, a page or a record that the bot can go and read for itself",
    preference:
      "the answer is the person's to give: a taste, a priority, a budget, a risk they are willing to take, or a choice between options that are all acceptable",
    blocked:
      "the answer needs something the bot does not have: a credential, an access the workspace has not granted, or something known only to the person",
    none_of_these: "none of the three above fit `question`",
  },
};

/** One option per tool, each described in the manifest's own words, plus an option for no tool. */
export function answeringToolQuestion(manifest: readonly ManifestTool[]): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const tool of manifest) criteria[tool.name] = tool.description;
  criteria[noToolOption(manifest)] = "no tool in `toolManifest` would answer `question`";
  return {
    type: "choice",
    instructions: "Which tool in `toolManifest` would answer `question`?",
    criteria,
  };
}

/**
 * Neither answer here is a failure. A tool was tried or it was not, and `askGateVerdict()` branches
 * on which; a confident no is as good a state as a confident yes, and the only thing that costs
 * this gate anything is a judge that could not say. So its confidence is how sure the judge was,
 * which is what `passingAnswer: "either"` asks for.
 */
export const ALREADY_TRIED_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Do `recentToolCalls` show the bot already trying to answer `question` with a tool?",
  criteria: {
    true: "`recentToolCalls` carry a call that was an attempt at this question, whether or not it produced an answer",
    false: "nothing in `recentToolCalls` was an attempt at this question",
  },
  passingAnswer: "either",
};

/**
 * The question set for one outbound question. The two that code can already answer are left out:
 * there is no tool to pick from an empty manifest, and nothing was tried when nothing was run.
 */
export function askGateQuestions(
  manifest: readonly ManifestTool[],
  recentCalls: readonly string[],
): Questions {
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = {
    [QUESTION_KIND_ID]: QUESTION_KIND_QUESTION,
  };
  if (manifest.length > 0) questions[ANSWERING_TOOL_ID] = answeringToolQuestion(manifest);
  if (recentCalls.length > 0) questions[ALREADY_TRIED_ID] = ALREADY_TRIED_QUESTION;
  return questions;
}

// ---------------------------------------------------------------------------
// What code owns.
// ---------------------------------------------------------------------------

export interface AskGateVerdictInput {
  readonly kind: AskKind | null;
  readonly bottomBand: boolean;
  /** A tool the manifest actually has was picked. */
  readonly toolChosen: boolean;
  readonly alreadyTried: boolean;
}

/**
 * What the answers add up to. Three of the four conditions on the only silencing verdict are facts.
 *
 * The order is the point. An answer the judge was not sure of never suppresses, whatever it said.
 * A question the bot could run is only held back when a real tool was named and the bot has not
 * already been around this loop. Everything else reaches the person, and the two ways of reaching
 * them are told apart so the flagged ones can be counted later.
 */
export function askGateVerdict(input: AskGateVerdictInput): AskVerdict {
  if (input.bottomBand) return "pass_flagged";
  if (input.kind === "runnable") {
    return input.toolChosen && !input.alreadyTried ? "suppress" : "pass_flagged";
  }
  if (input.kind === "preference" || input.kind === "blocked") return "pass";
  return "pass_flagged";
}

/** The one line the bot or the person is given with the verdict. Written in code, never asked. */
export function askGateReason(
  verdict: AskVerdict,
  kind: AskKind | null,
  tool: ToolOutcome | null,
  tried: TriedOutcome,
  manifestEmpty: boolean,
  bottomBand: boolean,
): string {
  if (verdict === "suppress") return `run ${tool?.name}: the bot has a tool that answers this`;
  if (verdict === "pass") {
    return kind === "preference"
      ? "this one is the person's call, not a fact the bot can look up"
      : "the bot cannot reach what this needs, so the person has to unblock it";
  }
  // The band comes first. An unsure answer is why this was flagged even when the answers it gave
  // look like a clean runnable, and reporting the tool instead would name a problem that is not
  // the one that held the question back.
  if (bottomBand) return "the judge was not sure enough to hold this back";
  if (kind === "runnable") {
    if (tried.value) return "a tool for this was already tried, so asking again is the person's turn";
    if (manifestEmpty) return "a tool could answer this, but the bot has none enabled";
    return "a tool could answer this, but no tool in the manifest was named";
  }
  if (kind === "none_of_these") return "none of runnable, preference or blocked fit this question";
  return "the judge was not sure enough to hold this back";
}

/**
 * The questions the judge was least sure of, which is what the certainty band actually saw.
 *
 * Certainty rather than pass confidence, for the same reason the verdict reads `certaintyBand`:
 * two of these three questions have no passing answer at all, and ranking a classification by how
 * much it passed is ranking it by nothing.
 */
export function weakestQuestions(answers: Answers): readonly string[] {
  const scored = Object.entries(answers).map(([id, answer]) => [id, certaintyOf(answer)] as const);
  if (scored.length === 0) return [];
  const lowest = Math.min(...scored.map(([, certainty]) => certainty));
  return scored.filter(([, certainty]) => certainty === lowest).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// The call.
// ---------------------------------------------------------------------------

/**
 * Runs the gate. One call, one deadline, one fallback.
 *
 * On a judge that does not answer the verdict is null and the action is the policy's fallback,
 * which is to pass. A question nobody could classify is a question that gets asked: the cost of
 * sending one the bot could have run is a person reading a sentence, and the cost of holding one
 * back is a customer waiting on a bot that decided not to ask.
 */
export async function askGate(input: AskGateInput, options: AskOptions = {}): Promise<AskGateOutcome> {
  if (typeof input.question !== "string" || input.question.trim().length === 0) {
    throw new TypeError("an ask gate needs the question the bot is about to send");
  }
  const manifest = normaliseManifest(input.toolManifest);
  if (manifest.length > ASK_GATE_MAX_TOOLS) {
    throw new TypeError(
      `an ask gate was handed ${manifest.length} tools, and a choice tops out at ${ASK_GATE_MAX_TOOLS} plus the option for none`,
    );
  }
  const recentCalls = recentToolNames(input.recentToolCalls);

  const state: AskGateState = {
    question: input.question,
    ...(input.taskSummary === undefined ? {} : { taskSummary: input.taskSummary }),
    toolManifest: manifest,
    recentToolCalls: input.recentToolCalls ?? [],
  };

  const outcome = await ask(
    {
      decision: ASK_GATE_DECISION,
      state,
      questions: askGateQuestions(manifest, recentCalls),
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
      kind: null,
      kindConfidence: 0,
      tool: null,
      alreadyTried: { value: false, by: null, noul: null, inRecentCalls: false },
      reason: "unjudged, so the question goes to the person unchanged",
      weakest: [],
      error: { reason: outcome.error.reason, detail: outcome.error.detail },
    };
  }

  const kindAnswer = outcome.answers[QUESTION_KIND_ID];
  const kind = kindAnswer !== undefined && kindAnswer.type === "choice" && isAskKind(kindAnswer.choice)
    ? kindAnswer.choice
    : null;
  const kindConfidence = kindAnswer === undefined ? 0 : certaintyOf(kindAnswer);

  const toolAnswer = outcome.answers[ANSWERING_TOOL_ID];
  const tool: ToolOutcome | null = toolAnswer === undefined || toolAnswer.type !== "choice"
    ? null
    : {
        name: manifest.some((entry) => entry.name === toolAnswer.choice) ? toolAnswer.choice : null,
        chosen: toolAnswer.choice,
        inManifest: manifest.some((entry) => entry.name === toolAnswer.choice),
        confidence: certaintyOf(toolAnswer),
      };

  const triedAnswer = outcome.answers[ALREADY_TRIED_ID];
  const triedNoul = triedAnswer !== undefined && triedAnswer.type === "noul" ? triedAnswer.noul : null;
  const inRecentCalls = tool?.name !== null && tool?.name !== undefined && recentCalls.includes(tool.name);
  const byJudge = triedNoul !== null && triedNoul >= ASK_GATE_TRIED_FLOOR;
  const alreadyTried: TriedOutcome = {
    value: inRecentCalls || byJudge,
    by: inRecentCalls && byJudge ? "both" : inRecentCalls ? "code" : byJudge ? "judge" : null,
    noul: triedNoul,
    inRecentCalls,
  };

  const bottomBand = isBottomBand(outcome.certaintyBand ?? outcome.band);
  const verdict = askGateVerdict({
    kind,
    bottomBand,
    toolChosen: tool?.name !== null && tool?.name !== undefined,
    alreadyTried: alreadyTried.value,
  });

  return {
    ...base,
    verdict,
    kind,
    kindConfidence,
    tool,
    alreadyTried,
    reason: askGateReason(verdict, kind, tool, alreadyTried, manifest.length === 0, bottomBand),
    weakest: weakestQuestions(outcome.answers),
  };
}

function isAskKind(value: string): value is AskKind {
  return (ASK_KINDS as readonly string[]).includes(value);
}
