import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The MCP server as a client meets it: the built `dist/mcp/server.js`, spawned over stdio, talking
 * to a fake /v1/systemone judge on a random port. Nothing leaves the machine, so this runs offline.
 * `npm test` builds before it tests, which is what puts the server in dist.
 */

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp", "server.js");

interface JudgeCall {
  readonly model: string;
  readonly questions: Record<string, { type: string }>;
  readonly state: Record<string, unknown>;
}

/** Answers every question as a noul unless told otherwise, after an optional delay. */
let answerWith: (call: JudgeCall) => Record<string, unknown> = () => ({});
let delayMs = 0;
const calls: JudgeCall[] = [];
let endpoint = "";

const judge = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  request.on("end", () => {
    const call = JSON.parse(body) as JudgeCall;
    calls.push(call);
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ model: "fake-jeb-1", answers: answerWith(call), usage: { input_tokens: 10, output_tokens: 5 } }));
    }, delayMs);
  });
});

before(async () => {
  await new Promise<void>((done) => judge.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(judge.address() as AddressInfo).port}/v1/systemone`;
});

after(() => {
  judge.closeAllConnections();
  judge.close();
});

function nouls(values: Record<string, number>): (call: JudgeCall) => Record<string, unknown> {
  return (call) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(call.questions)) answers[id] = { type: "noul", noul: values[id] ?? 0.95 };
    return answers;
  };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "jde-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { JDE_LEDGER: "off", ...env },
      stderr: "ignore",
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ body: Record<string, any>; isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text ?? "";
  const isError = result.isError === true;
  return { body: isError ? {} : (JSON.parse(text) as Record<string, any>), isError, text };
}

const TASK = {
  task: "Find three Node job queue libraries, write a comparison to docs/queues.md, and recommend one.",
  task_parts: [
    { kind: "action", text: "search for Node job queue libraries" },
    { kind: "file", text: "write the comparison", path: "docs/queues.md" },
    { kind: "reply", text: "the recommended library" },
  ],
  claimed_result: "Compared BullMQ, Bee-Queue and Agenda in docs/queues.md. Recommend BullMQ.",
  receipts: {
    tool_calls: [{ name: "web_search", count: 3 }, { name: "write_file", count: 1 }],
    files_written: [{ path: "docs/queues.md", bytes: 2048 }],
    searches: 3,
  },
};

test("it lists both tools, and says when to call the completion check", async () => {
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint });
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...byName.keys()].sort(), ["ask", "check_completion"]);
    const check = byName.get("check_completion")!;
    assert.match(check.description ?? "", /before you tell the user the task is finished/);
    assert.deepEqual([...(check.inputSchema.required ?? [])].sort(), ["claimed_result", "receipts", "task", "task_parts"]);
  } finally {
    await client.close();
  }
});

test("a task whose receipts carry every part is done", async () => {
  answerWith = nouls({ result_is_echo: 0.03 });
  delayMs = 0;
  calls.length = 0;
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint, JDE_JEB_MODEL: "jebadiah-test" });
  try {
    const { body } = await call(client, "check_completion", { ...TASK, claimed_parts: [0, 1, 2] });
    assert.equal(body.verdict, "done");
    assert.equal(body.action, "accept");
    assert.equal(body.judge, "fake-jeb-1");
    assert.deepEqual(body.parts.map((part: { passes: boolean }) => part.passes), [true, true, true]);
    assert.equal(body.parts[1].evidence, "file written");
    assert.deepEqual(body.result_is_echo, { value: false, noul: 0.03 });
    assert.deepEqual(body.overclaim, { parts: [], any: false });
    assert.equal(typeof body.latencyMs, "number");
    assert.match(body.next, /Report the task done/);

    // The judge got the model the env named, and never the file part, which code settles.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, "jebadiah-test");
    assert.deepEqual(Object.keys(calls[0]!.questions), ["result_is_echo", "part_0_done", "part_2_done"]);
    assert.equal("claimed_parts" in calls[0]!.state, false);
  } finally {
    await client.close();
  }
});

test("a part the receipts do not carry makes the task partial, and a claim of it an overclaim", async () => {
  answerWith = nouls({ result_is_echo: 0.03, part_0_done: 0.08 });
  delayMs = 0;
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint });
  try {
    const { body } = await call(client, "check_completion", { ...TASK, claimed_parts: [0, 1, 2] });
    assert.equal(body.verdict, "partial");
    assert.deepEqual(body.parts.map((part: { passes: boolean }) => part.passes), [false, true, true]);
    assert.deepEqual(body.overclaim, { parts: [0], any: true });
    assert.match(body.next, /Part 0 is not carried/);
  } finally {
    await client.close();
  }
});

test("with nothing listening, the check falls back and the error says how to start a judge", async () => {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((done) => closed.close(() => done()));

  const client = await connect({ JDE_JEB_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone` });
  try {
    const { body, isError } = await call(client, "check_completion", TASK);
    assert.equal(isError, false, "a judge that is down is an outcome, not a tool error");
    assert.equal(body.verdict, null);
    assert.equal(body.action, "fall_back");
    assert.equal(body.error.reason, "network");
    assert.match(body.error.hint, /pip install jebadiah-decide && jeb serve/);
    assert.match(body.next, /not verified/);
  } finally {
    await client.close();
  }
});

test("JDE_TIMEOUT_MS raises the policy's deadline for a slow local judge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jde-mcp-"));
  const policyPath = join(dir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      "completion-check": {
        bands: [{ at_least: 0.9, action: "accept" }, { at_least: 0, action: "fall_back" }],
        aggregate: "all_parts_at_least_0.7",
        on_error: "fall_back",
        timeout_ms: 100,
      },
    }),
  );
  answerWith = nouls({ result_is_echo: 0.03 });
  delayMs = 400;

  const strict = await connect({ JDE_JEB_ENDPOINT: endpoint, JDE_POLICY_PATH: policyPath });
  try {
    const { body } = await call(strict, "check_completion", TASK);
    assert.equal(body.verdict, null);
    assert.equal(body.error.reason, "timeout");
    assert.match(body.error.hint, /JDE_TIMEOUT_MS/);
  } finally {
    await strict.close();
  }

  const patient = await connect({ JDE_JEB_ENDPOINT: endpoint, JDE_POLICY_PATH: policyPath, JDE_TIMEOUT_MS: "5000" });
  try {
    const { body } = await call(patient, "check_completion", TASK);
    assert.equal(body.verdict, "done");
  } finally {
    await patient.close();
    delayMs = 0;
  }
});

test("the ledger is written to JDE_LEDGER_PATH unless JDE_LEDGER is off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jde-mcp-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  answerWith = nouls({ result_is_echo: 0.03 });
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint, JDE_LEDGER: "", JDE_LEDGER_PATH: ledgerPath });
  try {
    await call(client, "check_completion", TASK);
  } finally {
    await client.close();
  }
  const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.question), ["result_is_echo", "part_0_done", "part_2_done", "aggregate"]);
  assert.equal(JSON.stringify(rows).includes("BullMQ"), false, "the ledger never holds the state");
});

test("a file part with no path is refused as a tool error", async () => {
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint });
  try {
    const { isError, text } = await call(client, "check_completion", {
      ...TASK,
      task_parts: [{ kind: "file", text: "write the comparison" }],
    });
    assert.equal(isError, true);
    assert.match(text, /file part with no path/);
  } finally {
    await client.close();
  }
});

test("ask answers typed questions and applies the default bands to a decision the policy lacks", async () => {
  answerWith = () => ({
    supported: { type: "noul", noul: 0.96 },
    scope: { type: "choice", choice: "national", confidence: 0.93 },
  });
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint });
  try {
    const { body } = await call(client, "ask", {
      decision: "claim-supported",
      state: { claim: "BullMQ is maintained", evidence: "last release 2 weeks ago" },
      questions: {
        supported: {
          type: "noul",
          instructions: "Does `evidence` support `claim`?",
          criteria: { true: "it does", false: "it does not" },
        },
        scope: {
          type: "choice",
          instructions: "Is `claim` about a local or a national matter?",
          criteria: { local: "local", national: "national", neither: "neither fits" },
        },
      },
    });
    assert.equal(body.decision, "claim-supported");
    assert.equal(body.action, "accept");
    assert.equal(body.band, "90plus");
    assert.equal(body.answers.scope.choice, "national");
  } finally {
    await client.close();
  }
});

test("ask refuses a noul whose criteria are not true and false", async () => {
  const client = await connect({ JDE_JEB_ENDPOINT: endpoint });
  try {
    const { isError, text } = await call(client, "ask", {
      decision: "x",
      state: {},
      questions: { q: { type: "noul", instructions: "Is it?", criteria: { yes: "a", no: "b" } } },
    });
    assert.equal(isError, true);
    assert.match(text, /exactly "true" and "false"/);
  } finally {
    await client.close();
  }
});
