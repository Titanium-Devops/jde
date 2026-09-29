import type { Judge } from "../types.ts";
import { jebJudge } from "./jeb.ts";
import { jevJudge } from "./jev.ts";

export { jebJudge, JEB_API_KEY_ENV, JEB_ENDPOINT, JEB_ENDPOINT_ENV, JEB_MODEL, JEB_MODEL_ENV, JEB_START_HINT } from "./jeb.ts";
export type { JebJudgeOptions } from "./jeb.ts";
export { jevJudge, JEV_ENDPOINT, JEV_MODEL, TYPESAFE_API_KEY_ENV } from "./jev.ts";
export type { JevJudgeOptions } from "./jev.ts";
export { systemOneJudge } from "./systemone.ts";
export type { SystemOneJudgeOptions } from "./systemone.ts";
export { codeJudge } from "./code.ts";
export type { CodeAnswer, CodeJudgeOptions } from "./code.ts";

/** The judge a policy entry gets when it names none. */
export const DEFAULT_JUDGE = "jeb";

/**
 * The judges a policy may name: `jeb` (the default, a local Jeb) and `jev` (TypeSafe's hosted
 * service, opt in). A judge that needs arguments, like `code`, is passed in by the caller.
 */
export function judgeNamed(name: string): Judge {
  if (name === "jeb") return jebJudge();
  if (name === "jev") return jevJudge();
  throw new Error(`no judge named "${name}" can be built from a policy file (known: jeb, jev). Pass a judge instead.`);
}
