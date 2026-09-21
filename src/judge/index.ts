import type { Judge } from "../types.ts";
import { jevJudge } from "./jev.ts";

export { jevJudge, JEV_ENDPOINT, JEV_MODEL, TYPESAFE_API_KEY_ENV } from "./jev.ts";
export type { JevJudgeOptions } from "./jev.ts";
export { codeJudge } from "./code.ts";
export type { CodeAnswer, CodeJudgeOptions } from "./code.ts";

/**
 * The judges a policy may name. Only the ones that need no arguments are here: a code judge has
 * to be handed its answers, so a test passes the instance in rather than naming it in a file.
 */
export function judgeNamed(name: string): Judge {
  if (name === "jev") return jevJudge();
  throw new Error(`no judge named "${name}" can be built from a policy file. Pass a judge instead.`);
}
