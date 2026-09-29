import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ask } from "../src/index.ts";
import { DEFAULT_JUDGE, JEB_ENDPOINT, JEB_MODEL, jebJudge, judgeNamed } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import { loadPolicyBook } from "../src/policy.ts";
import type { PolicyBook, Questions } from "../src/types.ts";

const POLICY: PolicyBook = {
  "judge-test": {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0, action: "fall_back" },
    ],
    aggregate: "min_confidence",
    on_error: "fall_back",
    timeout_ms: 2000,
  },
};

const QUESTIONS: Questions = {
  holds: { type: "noul", instructions: "Does it hold?", criteria: { true: "it holds", false: "it does not" } },
};

interface Seen {
  path: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A stand-in for `jeb serve`: a real HTTP server on localhost that answers the Jev wire. */
async function fakeJebServe(answer: Record<string, unknown>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/systemone`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** Run with env vars set, and put them back afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every URL fetch was called with while `fn` ran. */
async function fetchedUrls<T>(fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return original(input, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = original;
  }
}

test("the default judge is a local Jeb at localhost:8100", () => {
  assert.equal(DEFAULT_JUDGE, "jeb");
  assert.equal(JEB_ENDPOINT, "http://localhost:8100/v1/systemone");
  assert.equal(JEB_MODEL, "jebadiah-9b-v2");
  assert.equal(judgeNamed("jeb").id, "jebadiah-9b-v2");
  assert.equal(judgeNamed("jev").id, "jev-latest");
  assert.throws(() => judgeNamed("gpt"), /known: jeb, jev/);
});

test("the shipped policy names the local judge", () => {
  const book = loadPolicyBook();
  for (const [name, entry] of Object.entries(book)) {
    assert.notEqual(entry.judge, "jev", `${name} must not default to the hosted judge`);
  }
});

test("a policy entry that names no judge is answered by the local Jeb, with no key", async () => {
  const jeb = await fakeJebServe({
    model: "jebadiah-9b-v2",
    answers: { holds: { type: "noul", noul: 0.97 } },
    usage: { input_tokens: 90, output_tokens: 0 },
  });
  try {
    const { result: outcome, urls } = await withEnv(
      { JDE_JEB_ENDPOINT: jeb.url, JDE_JEB_MODEL: undefined, JDE_JEB_API_KEY: undefined, TYPESAFE_API_KEY: undefined },
      () => fetchedUrls(() => ask({ decision: "judge-test", state: { a: 1 }, questions: QUESTIONS }, { policy: POLICY, ledger: memoryLedger() })),
    );
    assert.equal(outcome.action, "accept");
    assert.equal(outcome.judge, "jebadiah-9b-v2");
    assert.deepEqual(urls, [jeb.url], "one request, to the local endpoint, nothing else");
    assert.equal(jeb.seen.length, 1);
    assert.equal(jeb.seen[0]?.path, "/v1/systemone");
    assert.equal(jeb.seen[0]?.authorization, undefined, "no key is needed or sent");
    assert.equal(jeb.seen[0]?.body.model, "jebadiah-9b-v2");
    assert.deepEqual(jeb.seen[0]?.body.state, { a: 1 });
  } finally {
    await jeb.close();
  }
});

test("one setting names the model, ready for Judge Jeb; a key is sent only when set", async () => {
  const jeb = await fakeJebServe({ answers: { holds: { type: "noul", noul: 0.95 } } });
  try {
    const outcome = await withEnv(
      { JDE_JEB_ENDPOINT: jeb.url, JDE_JEB_MODEL: "judge-jeb-test", JDE_JEB_API_KEY: "local-key-for-this-test" },
      () => ask({ decision: "judge-test", state: {}, questions: QUESTIONS }, { policy: POLICY, ledger: memoryLedger() }),
    );
    assert.equal(outcome.judge, "judge-jeb-test", "a reply with no model records the configured name");
    assert.equal(jeb.seen[0]?.body.model, "judge-jeb-test");
    assert.equal(jeb.seen[0]?.authorization, "Bearer local-key-for-this-test");
  } finally {
    await jeb.close();
  }
});

test("no local Jeb: the policy's fallback, a message saying how to start one, and no hosted call", async () => {
  const { result: outcome, urls } = await withEnv(
    { JDE_JEB_ENDPOINT: "http://127.0.0.1:9/v1/systemone", TYPESAFE_API_KEY: "would-be-spent-if-it-fell-back" },
    () => fetchedUrls(() => ask({ decision: "judge-test", state: {}, questions: QUESTIONS }, { policy: POLICY, ledger: memoryLedger() })),
  );
  assert.equal(outcome.action, "fall_back");
  assert.equal(outcome.error?.reason, "network");
  assert.match(outcome.error?.detail ?? "", /pip install jebadiah-decide && jeb serve/);
  assert.ok(urls.every((u) => !u.includes("typesafe")), "never falls back to the hosted judge");
});

test("the hosted judge is opt in, and says it needs its own key", async () => {
  const policy: PolicyBook = { "judge-test": { ...POLICY["judge-test"]!, judge: "jev" } };
  const { result: outcome, urls } = await withEnv({ TYPESAFE_API_KEY: undefined }, () =>
    fetchedUrls(() => ask({ decision: "judge-test", state: {}, questions: QUESTIONS }, { policy, ledger: memoryLedger() })),
  );
  assert.equal(outcome.error?.reason, "no_key");
  assert.match(outcome.error?.detail ?? "", /only needed for the hosted Jev judge/);
  assert.deepEqual(urls, [], "no request without a key");
  assert.equal(jebJudge({ endpoint: "http://x/v1/systemone", model: "m" }).id, "m");
});
