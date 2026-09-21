import { JudgeError } from "../types.ts";
import type { Answer, Answers, FailureReason, Judge, JudgeReply, Questions } from "../types.ts";

/**
 * A deterministic judge, for tests and for questions that turned out to be facts.
 *
 * It is handed the answers it should give, keyed by question id, and gives them. Every test of a
 * band, an aggregate, a fallback or a ledger row uses this judge, so the suite runs offline and a
 * threshold change is measured against arithmetic rather than against a model's mood.
 */

/** A shorthand per question: a boolean or a number is a noul, a string is a choice. */
export type CodeAnswer = boolean | number | string | Answer;

export interface CodeJudgeOptions {
  readonly id?: string;
  readonly answers?: Readonly<Record<string, CodeAnswer>>;
  /** Answers built from the questions themselves, when a fixed map is not enough. */
  readonly answerFor?: (questionId: string, questions: Questions, state: unknown) => CodeAnswer | undefined;
  /** Waits this long before answering, so a test can let the policy deadline win. */
  readonly delayMs?: number;
  /** Fails this way instead of answering. */
  readonly fail?: FailureReason;
  /** Answers with this exact body, so a test can hand back something malformed. */
  readonly raw?: Answers;
}

export function codeJudge(options: CodeJudgeOptions = {}): Judge {
  return {
    id: options.id ?? "code",
    async ask(state: unknown, questions: Questions, signal: AbortSignal): Promise<JudgeReply> {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await waitOrAbort(options.delayMs, signal);
      }
      if (options.fail !== undefined) {
        throw new JudgeError(options.fail, "the code judge was told to fail");
      }
      if (options.raw !== undefined) return { answers: options.raw };

      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(questions)) {
        const given = options.answers?.[id] ?? options.answerFor?.(id, questions, state);
        if (given === undefined) continue;
        answers[id] = asAnswer(given);
      }
      return { answers };
    },
  };
}

function asAnswer(given: CodeAnswer): Answer {
  if (typeof given === "boolean") return { type: "noul", noul: given ? 1 : 0 };
  if (typeof given === "number") return { type: "noul", noul: given };
  if (typeof given === "string") return { type: "choice", choice: given, confidence: 1 };
  return given;
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      fail(new JudgeError("timeout", "no answer before the deadline"));
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
