import type { Judge } from "../types.ts";
import { systemOneJudge } from "./systemone.ts";

/**
 * The default judge: Jeb, the open Jebadiah decision model, running on your own machine behind
 * `jeb serve` (pip install jebadiah-decide). It answers the same Jev wire as the hosted service,
 * so nothing else in JDE changes.
 *
 * Point it elsewhere with JDE_JEB_ENDPOINT (AINode, or any /v1/systemone server) and name the
 * model with JDE_JEB_MODEL. That one setting is how JDE moves to Judge Jeb, the judge-tuned model,
 * when it ships; it is not released yet. `jeb serve` answers with whatever model it loaded, so
 * there the name is a label for the ledger; AINode routes by it.
 *
 * When nothing answers, the failure says how to start one. It never falls back to a hosted judge.
 */

export const JEB_ENDPOINT = "http://localhost:8100/v1/systemone";
export const JEB_MODEL = "jebadiah-9b-v2";
export const JEB_ENDPOINT_ENV = "JDE_JEB_ENDPOINT";
export const JEB_MODEL_ENV = "JDE_JEB_MODEL";
export const JEB_API_KEY_ENV = "JDE_JEB_API_KEY";
export const JEB_START_HINT = "Start a local Jeb: pip install jebadiah-decide && jeb serve";

export interface JebJudgeOptions {
  readonly endpoint?: string;
  readonly model?: string;
  /** Only so a test can answer without a network. Production passes nothing. */
  readonly fetchImpl?: typeof fetch;
}

export function jebJudge(options: JebJudgeOptions = {}): Judge {
  return systemOneJudge({
    endpoint: options.endpoint ?? (process.env[JEB_ENDPOINT_ENV] || JEB_ENDPOINT),
    model: options.model ?? (process.env[JEB_MODEL_ENV] || JEB_MODEL),
    apiKey: () => process.env[JEB_API_KEY_ENV],
    unreachableHint: JEB_START_HINT,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
