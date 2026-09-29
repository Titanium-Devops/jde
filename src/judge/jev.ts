import type { Judge } from "../types.ts";
import { systemOneJudge } from "./systemone.ts";

/**
 * TypeSafe's hosted Jev, opt in: name `"judge": "jev"` in a policy entry, or pass `jevJudge()`.
 * It was the only judge when JDE was written; the default is now a local Jeb (`jeb.ts`). Nothing
 * falls back to this one: a request reaches TypeSafe only when a policy or a caller asks for it.
 *
 * The key is read from TYPESAFE_API_KEY and from nowhere else.
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
  return systemOneJudge({
    endpoint: options.endpoint ?? JEV_ENDPOINT,
    model: options.model ?? JEV_MODEL,
    apiKey: () => process.env[TYPESAFE_API_KEY_ENV],
    requireKey: `${TYPESAFE_API_KEY_ENV} is not set in this process (it is only needed for the hosted Jev judge)`,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
