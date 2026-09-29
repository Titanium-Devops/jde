import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent, run, tool } from "@openai/agents";
import type { AgentInputItem, RunItem } from "@openai/agents";
import { completionCheck } from "jde";
import type { CompletionOutcome, Receipts, TaskPart } from "jde";
import { z } from "zod";

/**
 * An OpenAI Agents SDK agent whose last step is a JDE completion check. When the check says the
 * task is not done, the agent gets the same conversation back with the missing parts named, and
 * tries again. The receipts come from what the run actually did, never from the agent's report.
 */

const TASK = "Write a haiku about job queues to out/haiku.md, then tell me which of its three lines is the strongest.";

// The task split into its parts, in code. The file part is checked by JDE without a model.
const PARTS: TaskPart[] = [
  { kind: "file", text: "write the haiku", path: "out/haiku.md" },
  { kind: "reply", text: "which line of the haiku is the strongest" },
];

// The tool records what it wrote, so the receipts are what happened on disk.
const filesWritten: { path: string; bytes: number }[] = [];

const writeFileTool = tool({
  name: "write_file",
  description: "Write text to a file at a relative path.",
  parameters: z.object({ path: z.string(), content: z.string() }),
  async execute({ path, content }) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    filesWritten.push({ path, bytes: Buffer.byteLength(content) });
    return `wrote ${path}`;
  },
});

const agent = new Agent({
  name: "writer",
  instructions: "Do every part of the task with your tools, then report what you did in one or two sentences.",
  model: "gpt-4.1-mini",
  tools: [writeFileTool],
});

/** Tool calls counted by name, across every attempt so far. */
const toolCalls = new Map<string, number>();

function countToolCalls(items: RunItem[]): void {
  for (const item of items) {
    if (item.type !== "tool_call_item" || item.rawItem.type !== "function_call") continue;
    toolCalls.set(item.rawItem.name, (toolCalls.get(item.rawItem.name) ?? 0) + 1);
  }
}

/** One run of the agent. Its tool calls go into the receipts before anything reads its report. */
async function attempt(input: string | AgentInputItem[]): Promise<{ claimed: string; history: AgentInputItem[] }> {
  const result = await run(agent, input);
  countToolCalls(result.newItems);
  return { claimed: String(result.finalOutput ?? ""), history: result.history };
}

function receipts(): Receipts {
  return {
    tool_calls: [...toolCalls].map(([name, count]) => ({ name, count })),
    files_written: filesWritten,
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("Set OPENAI_API_KEY to run the agent. Start a judge first: pip install jebadiah-decide && jeb serve");
    return;
  }

  let input: string | AgentInputItem[] = TASK;
  let check: CompletionOutcome | undefined;
  for (let round = 1; round <= 3; round++) {
    const { claimed, history } = await attempt(input);

    check = await completionCheck({ task: TASK, task_parts: PARTS, claimed_result: claimed, receipts: receipts() });
    console.log(`attempt ${round}: ${check.verdict ?? `not judged (${check.error?.detail})`}`);

    // Done, or the judge could not say: either way, stop. An unjudged run is not a failed one.
    if (check.verdict === "done" || check.verdict === null) {
      console.log(claimed);
      return;
    }

    const missing = check.parts.filter((part) => !part.passes).map((part) => PARTS[part.index]!.text);
    input = [
      ...history,
      { role: "user", content: `A check found these parts not done: ${missing.join("; ")}. Do them now.` },
    ];
  }
  console.log(`Gave up after three attempts; last verdict ${check?.verdict}.`);
}

await main();
