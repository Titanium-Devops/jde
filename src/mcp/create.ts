import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { ask } from "../index.ts";
import { COMPLETION_DECISION, completionCheck } from "../decisions/completion-check.ts";
import type { CompletionOutcome, TaskPart } from "../decisions/completion-check.ts";
import { DEFAULT_JUDGE, JEB_ENDPOINT, JEB_ENDPOINT_ENV, JEB_START_HINT, judgeNamed, TYPESAFE_API_KEY_ENV } from "../judge/index.ts";
import { fileLedger, nullLedger } from "../ledger.ts";
import { loadPolicyBook } from "../policy.ts";
import type { Failure, Judge, Ledger, Outcome, PolicyEntry, Questions } from "../types.ts";

/**
 * JDE as an MCP server, so an agent in Claude Code, Cursor or any MCP client can check its own
 * work without anyone writing code.
 *
 * This file adds no judgment of its own. It turns tool arguments into the same completionCheck()
 * and ask() calls a TypeScript caller would make, with the same policy, judge and ledger, and
 * turns the outcome back into JSON. Everything it reads from the environment is read per call,
 * so a client that restarts nothing still sees a changed setting on its next call.
 */

/** Raises the policy's deadline, never lowers it. A local 27B can need a few seconds. */
export const TIMEOUT_ENV = "JDE_TIMEOUT_MS";
/** `jeb` (the default) or `jev`. */
export const JUDGE_ENV = "JDE_JUDGE";
/** `off` keeps the ledger out of it; anything else writes to the default ledger path. */
export const LEDGER_ENV = "JDE_LEDGER";

/**
 * What `ask` uses for a decision the policy file does not name. The shipped policy names only the
 * completion check, and an agent reaching for `ask` should get an answer rather than an error
 * about a file it cannot see. The bands are the completion check's, so the actions mean the same
 * thing in both tools.
 */
export const MCP_DEFAULT_ENTRY: PolicyEntry = {
  bands: [
    { at_least: 0.9, action: "accept" },
    { at_least: 0.7, action: "accept_with_note" },
    { at_least: 0, action: "fall_back" },
  ],
  aggregate: "min_confidence",
  on_error: "fall_back",
  timeout_ms: 2000,
};

export interface JdeServerOptions {
  /** Only for tests. Production reads process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Only for tests. Production builds the judge from JDE_JUDGE and the policy. */
  readonly judge?: Judge;
  /** Only for tests. Production uses the file ledger unless JDE_LEDGER=off. */
  readonly ledger?: Ledger;
}

export function createJdeServer(options: JdeServerOptions = {}): McpServer {
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const server = new McpServer({ name: "jde", version: packageVersion() });

  server.registerTool(
    "check_completion",
    {
      title: "Check that a task is actually done",
      description: CHECK_COMPLETION_DESCRIPTION,
      inputSchema: CHECK_COMPLETION_INPUT,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const parts = asTaskParts(args.task_parts);
      if ("problem" in parts) return problem(parts.problem);

      const setup = setupFor(COMPLETION_DECISION, env(), options);
      if ("problem" in setup) return problem(setup.problem);

      const outcome = await completionCheck(
        {
          task: args.task,
          task_parts: parts.parts,
          claimed_result: args.claimed_result,
          receipts: args.receipts,
          ...(args.claimed_parts === undefined ? {} : { claimed_parts: args.claimed_parts }),
        },
        { policyEntry: setup.entry, judge: setup.judge, ledger: setup.ledger },
      );
      return reply(completionReport(outcome, setup));
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask the judge typed questions",
      description: ASK_DESCRIPTION,
      inputSchema: ASK_INPUT,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const questions = asQuestions(args.questions);
      if ("problem" in questions) return problem(questions.problem);

      const setup = setupFor(args.decision, env(), options);
      if ("problem" in setup) return problem(setup.problem);

      const outcome = await ask(
        { decision: args.decision, state: args.state, questions: questions.questions },
        { policyEntry: setup.entry, judge: setup.judge, ledger: setup.ledger },
      );
      return reply(askReport(outcome, setup));
    },
  );

  return server;
}

const CHECK_COMPLETION_DESCRIPTION = [
  "Checks whether a task you were given is actually done, against the receipts of what you did rather than what you say you did.",
  "Call it once, after your last tool call and before you tell the user the task is finished. If the verdict is not `done`, do the missing parts (or say plainly which parts were not done) and call it again before reporting.",
  "",
  "How to fill it in:",
  "- `task`: the user's request, verbatim.",
  "- `task_parts`: the request split into the separate things it asks for, one entry each. `kind` is `file` when the part is a file at a known path (give `path`; code checks it, no model does), `reply` when the part is something you say in your answer (a recommendation, a number, a name), and `action` for anything else you had to do (a search, a test run, a deploy).",
  "- `claimed_result`: the report you are about to give the user, exactly as you would send it.",
  "- `receipts`: counted from your own tool log in this session, never estimated and never from memory. `tool_calls` is one entry per tool name with how many times you called it. `files_written` lists only files you actually wrote, with their byte size. `searches` and `pages_fetched` count web searches and fetches. Leave out what you did not do; an empty or missing receipt is honest, an invented one defeats the check.",
  "- `claimed_parts`: optional, the indexes into `task_parts` that your claimed_result says you did. Pass it to learn which claims the receipts do not carry.",
  "",
  "The answer: `verdict` is `done`, `partial` or `not_done`, or null when the judge did not answer (then `error` says why and how to start one; that is not a failure of your work). `parts` shows each part and whether it passed. `result_is_echo` is true when claimed_result restates the task instead of reporting an outcome. `next` says what to do. Act on `verdict`: `action` is the policy's band for how sure the judge was, not whether the work is done.",
].join("\n");

const ASK_DESCRIPTION = [
  "Asks the judge typed questions about a state and returns calibrated answers, the band they land in, and the action the policy attaches to that band.",
  "Use it for a judgment an `if` cannot settle: whether a claim is supported by its evidence, which of a fixed set of categories a request belongs to. Do not use it for facts code or a tool can check (whether a file exists, whether a number is over a limit).",
  "",
  "- `decision`: a short name for the judgment. It picks the policy entry and labels every ledger row; a name the policy file does not have gets default bands (accept at 0.9, accept_with_note at 0.7, otherwise fall_back).",
  "- `state`: a JSON object holding everything the judge needs, and nothing it should not see.",
  "- `questions`: keyed by an id you choose. `noul` asks whether something holds and needs `criteria` with exactly `true` and `false`. `choice` picks one option; its `criteria` maps each option to what it means, and should include an option for none of them fitting. `score` rates over ordered levels. Name the state field you mean in backticks in `instructions`.",
  "",
  "`action` is what to do; `answers` holds each answer (`noul` is the probability it holds, a choice has `choice` and `confidence`). On a judge failure the action is the fallback and `error` says why.",
].join("\n");

const TASK_PART = z.object({
  text: z.string().min(1).describe("What this part asks for, in a few words, e.g. `write the comparison`"),
  kind: z.enum(["action", "reply", "file"]).describe("`file`: a file at a known path. `reply`: something said in the answer. `action`: anything else done"),
  path: z.string().min(1).optional().describe("Required when kind is `file`: the exact path the file should be written to"),
});

const RECEIPTS = z.object({
  tool_calls: z
    .array(z.object({ name: z.string(), count: z.number().int().min(0) }))
    .optional()
    .describe("One entry per tool name you called in this task, with how many times"),
  files_written: z
    .array(z.object({ path: z.string(), bytes: z.number().int().min(0), first_line: z.string().optional() }))
    .optional()
    .describe("Every file you wrote, with its size in bytes and, optionally, its first line"),
  searches: z.number().int().min(0).optional().describe("Web or code searches run"),
  pages_fetched: z.number().int().min(0).optional().describe("Pages or URLs fetched"),
  transcript_entries: z.number().int().min(0).optional().describe("Messages and tool results in the session so far"),
  elapsed_s: z.number().min(0).optional().describe("Seconds spent on the task"),
});

const CHECK_COMPLETION_INPUT = {
  task: z.string().min(1).describe("The user's request, verbatim"),
  task_parts: z.array(TASK_PART).min(1).describe("The request split into its separate parts"),
  claimed_result: z.string().describe("The report you are about to give the user, exactly as written"),
  receipts: RECEIPTS.describe("What your tool log shows you did, counted, not estimated"),
  claimed_parts: z
    .array(z.number().int().min(0))
    .optional()
    .describe("Indexes into task_parts that claimed_result says were done"),
};

const QUESTION = z.object({
  type: z.enum(["noul", "choice", "score"]),
  instructions: z.string().min(1).describe("The question itself, naming the state field it is about"),
  criteria: z
    .record(z.string(), z.string())
    .describe("noul: exactly `true` and `false`. choice: one entry per option. score: one entry per level"),
});

const ASK_INPUT = {
  decision: z.string().min(1).describe("A short name for this judgment, e.g. `claim-supported`"),
  state: z.record(z.string(), z.unknown()).describe("Everything the judge needs to answer, as a JSON object"),
  questions: z.record(z.string(), QUESTION).describe("Typed questions keyed by an id you choose"),
};

interface Setup {
  readonly entry: PolicyEntry;
  readonly judge: Judge;
  readonly judgeName: string;
  readonly ledger: Ledger;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The policy entry, judge and ledger for one call. A setting that is wrong comes back as a tool
 * error naming the setting, rather than as a crash of the server the client spawned.
 */
function setupFor(decision: string, env: NodeJS.ProcessEnv, options: JdeServerOptions): Setup | { problem: string } {
  let entry: PolicyEntry;
  try {
    entry = loadPolicyBook()[decision] ?? MCP_DEFAULT_ENTRY;
  } catch (error) {
    return { problem: (error as Error).message };
  }

  const raised = Number(env[TIMEOUT_ENV]);
  if (env[TIMEOUT_ENV] !== undefined && env[TIMEOUT_ENV] !== "" && !(Number.isFinite(raised) && raised > 0)) {
    return { problem: `${TIMEOUT_ENV} must be a positive number of milliseconds, got "${env[TIMEOUT_ENV]}"` };
  }
  if (Number.isFinite(raised) && raised > entry.timeout_ms) entry = { ...entry, timeout_ms: raised };

  const judgeName = env[JUDGE_ENV] || entry.judge || DEFAULT_JUDGE;
  let judge: Judge;
  if (options.judge !== undefined) {
    judge = options.judge;
  } else {
    try {
      judge = judgeNamed(judgeName);
    } catch (error) {
      return { problem: `${JUDGE_ENV}: ${(error as Error).message}` };
    }
  }

  const ledger = options.ledger ?? (env[LEDGER_ENV] === "off" ? nullLedger() : fileLedger());
  return { entry, judge, judgeName, ledger, env };
}

/**
 * The completion outcome an agent needs, and not the ledger rows or the raw answers, which say
 * the same thing again at more length. `next` is worked out here, in code, from the verdict.
 */
function completionReport(outcome: CompletionOutcome, setup: Setup): Record<string, unknown> {
  return {
    verdict: outcome.verdict,
    action: outcome.action,
    parts: outcome.parts,
    result_is_echo: outcome.result_is_echo,
    ...(outcome.overclaim === undefined ? {} : { overclaim: outcome.overclaim }),
    confidence: outcome.confidence,
    band: outcome.band,
    judge: outcome.judge,
    latencyMs: outcome.latencyMs,
    ...(outcome.error === undefined ? {} : { error: withHint(outcome.error as Failure, setup) }),
    next: nextStep(outcome),
  };
}

function askReport(outcome: Outcome, setup: Setup): Record<string, unknown> {
  return {
    decision: outcome.decision,
    action: outcome.action,
    answers: outcome.answers,
    confidence: outcome.confidence,
    band: outcome.band,
    judge: outcome.judge,
    latencyMs: outcome.latencyMs,
    ...(outcome.error === undefined ? {} : { error: withHint(outcome.error, setup) }),
  };
}

function nextStep(outcome: CompletionOutcome): string {
  if (outcome.verdict === null) {
    return "No judgment was made because the judge did not answer. This says nothing about your work: report as you would have without the check, and mention it was not verified.";
  }
  const missing = outcome.parts.filter((part) => !part.passes).map((part) => part.index);
  const echo = outcome.result_is_echo?.value === true
    ? " Your claimed_result restates the task: rewrite it as what you did and what you found."
    : "";
  if (outcome.verdict === "done") return `Every part is carried by the receipts. Report the task done.${echo}`;
  const overclaimed = outcome.overclaim?.any === true
    ? ` Your report claims parts ${outcome.overclaim.parts.join(", ")} without receipts for them; do not claim them until they are done.`
    : "";
  const which = missing.length === 1 ? `Part ${missing[0]} is` : `Parts ${missing.join(", ")} are`;
  return `${which} not carried by the receipts. Do them, then check again, or report plainly that they were not done.${overclaimed}${echo}`;
}

/**
 * The failure, plus how to fix it. The Jeb judge already names `jeb serve` on a network failure;
 * a timeout or an HTTP error does not, and an agent reading either needs to know what to do.
 */
function withHint(error: Failure, setup: Setup): Failure & { hint: string } {
  const hints: string[] = [];
  if (setup.judgeName === "jev") {
    if (error.reason === "no_key") {
      hints.push(`Set ${TYPESAFE_API_KEY_ENV} in the MCP server's env, or unset ${JUDGE_ENV} to use a local Jeb.`);
    }
  } else {
    const endpoint = setup.env[JEB_ENDPOINT_ENV] || JEB_ENDPOINT;
    hints.push(`${JEB_START_HINT} (JDE looks for it at ${endpoint}; move it with ${JEB_ENDPOINT_ENV}).`);
  }
  if (error.reason === "timeout") {
    hints.push(`The judge had ${setup.entry.timeout_ms} ms. A local model can need a few seconds: raise ${TIMEOUT_ENV}.`);
  }
  return { ...error, hint: hints.join(" ") };
}

function asTaskParts(given: readonly { text: string; kind: TaskPart["kind"]; path?: string | undefined }[]): { parts: TaskPart[] } | { problem: string } {
  const parts: TaskPart[] = [];
  for (const [index, part] of given.entries()) {
    if (part.kind === "file") {
      if (part.path === undefined) return { problem: `task_parts[${index}] is a file part with no path` };
      parts.push({ kind: "file", text: part.text, path: part.path });
    } else {
      parts.push({ kind: part.kind, text: part.text });
    }
  }
  return { parts };
}

function asQuestions(given: Record<string, { type: "noul" | "choice" | "score"; instructions: string; criteria: Record<string, string> }>): { questions: Questions } | { problem: string } {
  const ids = Object.keys(given);
  if (ids.length === 0) return { problem: "questions is empty: ask at least one" };
  for (const id of ids) {
    const question = given[id]!;
    const keys = Object.keys(question.criteria).sort();
    if (question.type === "noul" && (keys.length !== 2 || keys[0] !== "false" || keys[1] !== "true")) {
      return { problem: `questions.${id} is a noul, so its criteria need exactly "true" and "false"` };
    }
    if (question.type !== "noul" && keys.length < 2) {
      return { problem: `questions.${id} is a ${question.type}, so its criteria need at least two options` };
    }
  }
  return { questions: given as Questions };
}

function reply(body: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

function problem(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** dist/mcp and src/mcp both sit two directories below the package root. */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
