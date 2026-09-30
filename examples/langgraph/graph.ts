import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { completionCheck } from "@titanium-devops/jde";
import type { CompletionVerdict, Receipts, TaskPart } from "@titanium-devops/jde";
import { z } from "zod";

/**
 * A LangGraph worker with a "verify" node after it. The worker loops with its tools until it
 * stops calling them; verify runs JDE's completion check on what the tools actually did, and
 * routes back to the worker with the missing parts named when the task is not done.
 */

const TASK = "Write a haiku about job queues to out/haiku.md, then tell me which of its three lines is the strongest.";

// The task split into its parts, in code. The file part is checked by JDE without a model.
const PARTS: TaskPart[] = [
  { kind: "file", text: "write the haiku", path: "out/haiku.md" },
  { kind: "reply", text: "which line of the haiku is the strongest" },
];

const MAX_ROUNDS = 3;

// The tool records what it wrote, so the receipts are what happened on disk.
const filesWritten: { path: string; bytes: number }[] = [];

const writeFileTool = tool(
  async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    filesWritten.push({ path, bytes: Buffer.byteLength(content) });
    return `wrote ${path}`;
  },
  {
    name: "write_file",
    description: "Write text to a file at a relative path.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
);

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  verdict: Annotation<CompletionVerdict | null | undefined>(),
  rounds: Annotation<number>({ reducer: (total, add) => total + add, default: () => 0 }),
});
type GraphState = typeof State.State;

// Built on first use, so drawing the graph needs no API key.
let model: ReturnType<ChatOpenAI["bindTools"]> | undefined;

async function worker(state: GraphState) {
  model ??= new ChatOpenAI({ model: "gpt-4.1-mini" }).bindTools([writeFileTool]);
  const instructions = new SystemMessage("Do every part of the task with your tools, then report what you did in one or two sentences.");
  return { messages: [await model.invoke([instructions, ...state.messages])] };
}

/** Tool calls counted by name from the conversation, which is the run's own record. */
function receiptsFrom(messages: BaseMessage[]): Receipts {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return { tool_calls: [...counts].map(([name, count]) => ({ name, count })), files_written: filesWritten };
}

async function verify(state: GraphState) {
  const claimed = state.messages.at(-1)?.text ?? "";
  const check = await completionCheck({
    task: TASK,
    task_parts: PARTS,
    claimed_result: claimed,
    receipts: receiptsFrom(state.messages),
  });
  console.log(`round ${state.rounds + 1}: ${check.verdict ?? `not judged (${check.error?.detail})`}`);
  if (check.verdict === "done" || check.verdict === null) return { verdict: check.verdict, rounds: 1 };

  const missing = check.parts.filter((part) => !part.passes).map((part) => PARTS[part.index]!.text);
  return {
    verdict: check.verdict,
    rounds: 1,
    messages: [new HumanMessage(`A check found these parts not done: ${missing.join("; ")}. Do them now.`)],
  };
}

function afterWorker(state: GraphState): "tools" | "verify" {
  const last = state.messages.at(-1);
  return last !== undefined && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0 ? "tools" : "verify";
}

// Done, or the judge could not say: either way, stop. An unjudged run is not a failed one.
function afterVerify(state: GraphState): "worker" | typeof END {
  if (state.verdict === "done" || state.verdict === null || state.rounds >= MAX_ROUNDS) return END;
  return "worker";
}

const graph = new StateGraph(State)
  .addNode("worker", worker)
  .addNode("tools", new ToolNode([writeFileTool]))
  .addNode("verify", verify)
  .addEdge(START, "worker")
  .addConditionalEdges("worker", afterWorker, ["tools", "verify"])
  .addEdge("tools", "worker")
  .addConditionalEdges("verify", afterVerify, ["worker", END])
  .compile();

if (!process.env.OPENAI_API_KEY) {
  console.log((await graph.getGraphAsync({})).drawMermaid());
  console.log("Set OPENAI_API_KEY to run the graph. Start a judge first: pip install jebadiah-decide && jeb serve");
} else {
  const final = await graph.invoke({ messages: [new HumanMessage(TASK)] });
  console.log(final.messages.findLast((message) => AIMessage.isInstance(message))?.text);
}
