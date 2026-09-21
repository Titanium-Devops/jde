import { JudgeError } from "../types.ts";
import type { Answer, Answers, Judge, JudgeReply, Questions } from "../types.ts";

/**
 * The hosted judge: one POST to TypeSafe's system one endpoint, with the questions as asked.
 *
 * One attempt. No retries, on purpose: a retry inside a turn spends the deadline twice over, and
 * the fallback for one failure and for two is the same fallback. The deadline itself belongs to
 * the policy, and arrives as a signal.
 *
 * The key is read from TYPESAFE_API_KEY and from nowhere else. It is never logged, never returned,
 * and never written to the ledger, which records no credential of any kind.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

export interface JevJudgeOptions {
  readonly endpoint?: string;
  readonly model?: string;
  /** Only so a test can answer without a network. Production passes nothing. */
  readonly fetchImpl?: typeof fetch;
}

export function jevJudge(options: JevJudgeOptions = {}): Judge {
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const model = options.model ?? JEV_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    id: model,
    async ask(state: unknown, questions: Questions, signal: AbortSignal): Promise<JudgeReply> {
      const apiKey = process.env[TYPESAFE_API_KEY_ENV];
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new JudgeError("no_key", `${TYPESAFE_API_KEY_ENV} is not set in this process`);
      }

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model, questions }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new JudgeError("timeout", "no answer before the deadline");
        throw new JudgeError("network", String((error as Error)?.message ?? error));
      }

      if (!response.ok) {
        throw new JudgeError("http_error", `${response.status}: ${await briefly(response)}`);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new JudgeError("malformed", "the answer was not JSON");
      }

      const body = parsed as Record<string, unknown> | null;
      const answers = parseAnswers(body?.answers);
      if (answers === undefined) throw new JudgeError("malformed", "the answers could not be read");

      const usage = (body?.usage ?? {}) as Record<string, unknown>;
      return {
        answers,
        model: typeof body?.model === "string" ? body.model : model,
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      };
    },
  };
}

/**
 * An error body says what went wrong, and on a 422 it can quote the state back. Only the named
 * error field is kept, and it is cut short, so a rejected request does not turn into a copy of
 * what was judged.
 */
async function briefly(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "no body";
  }
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const named = body.error ?? body.message ?? body.detail;
    if (typeof named === "string") return cut(named);
  } catch {
    // Not JSON. Fall through to the truncated text.
  }
  return cut(text);
}

function cut(text: string, max = 200): string {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat;
}

/** A shape check and nothing more: an answer this code cannot read is the same as no answer. */
function parseAnswers(value: unknown): Answers | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const answers: Record<string, Answer> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const answer = raw as Record<string, unknown>;

    if (answer.type === "noul") {
      if (!isFinite01(answer.noul)) return undefined;
      answers[id] = { type: "noul", noul: answer.noul as number };
      continue;
    }

    if (answer.type === "choice") {
      if (typeof answer.choice !== "string") return undefined;
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        confidence: isFinite01(answer.confidence) ? (answer.confidence as number) : 0,
        probabilities: asProbabilities(answer.probabilities),
      };
      continue;
    }

    if (answer.type === "score") {
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) return undefined;
      answers[id] = {
        type: "score",
        score: answer.score,
        confidence: isFinite01(answer.confidence) ? (answer.confidence as number) : 0,
        legend: answer.legend,
        probabilities: asProbabilities(answer.probabilities),
      };
      continue;
    }

    return undefined;
  }
  return answers;
}

function isFinite01(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asProbabilities(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}
