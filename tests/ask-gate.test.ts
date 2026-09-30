import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALREADY_TRIED_ID,
  ALREADY_TRIED_QUESTION,
  ANSWERING_TOOL_ID,
  answeringToolQuestion,
  askGate,
  askGateQuestions,
  askGateVerdict,
  normaliseManifest,
  noToolOption,
  QUESTION_KIND_ID,
  QUESTION_KIND_QUESTION,
  recentToolNames,
  weakestQuestions,
} from "../src/decisions/ask-gate.ts";
import type { ManifestTool } from "../src/decisions/ask-gate.ts";
import { codeJudge } from "../src/judge/index.ts";
import { memoryLedger } from "../src/ledger.ts";
import type { Answer, PolicyBook } from "../src/types.ts";

const POLICY: PolicyBook = {
  "ask-gate": {
    bands: [
      { at_least: 0.9, action: "accept" },
      { at_least: 0.7, action: "accept_with_note" },
      { at_least: 0, action: "pass_flagged" },
    ],
    aggregate: "min_confidence",
    on_error: "pass",
    timeout_ms: 750,
  },
};

const MANIFEST: readonly ManifestTool[] = [
  { name: "postAnalytics", description: "counts posts and engagement on a connected social account" },
  { name: "siteCheck", description: "fetches a URL and reports whether it responds" },
  { name: "driveSearch", description: "searches the workspace Drive for files" },
];

const QUESTION = "How many posts went out last week?";

function choice(value: string, confidence = 0.95): Answer {
  return { type: "choice", choice: value, confidence };
}

function noul(value: number): Answer {
  return { type: "noul", noul: value };
}

function run(
  answers: Record<string, Answer>,
  extra: { manifest?: unknown; recent?: unknown; question?: string } = {},
) {
  return askGate(
    {
      question: extra.question ?? QUESTION,
      taskSummary: "reporting on last week for a client",
      toolManifest: extra.manifest === undefined ? MANIFEST : extra.manifest,
      ...(extra.recent === undefined ? {} : { recentToolCalls: extra.recent }),
    },
    { policy: POLICY, judge: codeJudge({ id: "code-1", answers }), ledger: memoryLedger() },
  );
}

const RUNNABLE = {
  [QUESTION_KIND_ID]: choice("runnable"),
  [ANSWERING_TOOL_ID]: choice("postAnalytics"),
};

// ---------------------------------------------------------------------------
// The questions.
// ---------------------------------------------------------------------------

test("three questions, and the two code can already answer are left out", () => {
  assert.deepEqual(Object.keys(askGateQuestions(MANIFEST, ["siteCheck"])), [
    QUESTION_KIND_ID,
    ANSWERING_TOOL_ID,
    ALREADY_TRIED_ID,
  ]);
  assert.deepEqual(Object.keys(askGateQuestions(MANIFEST, [])), [QUESTION_KIND_ID, ANSWERING_TOOL_ID]);
  assert.deepEqual(Object.keys(askGateQuestions([], ["siteCheck"])), [QUESTION_KIND_ID, ALREADY_TRIED_ID]);
  assert.deepEqual(Object.keys(askGateQuestions([], [])), [QUESTION_KIND_ID]);
});

test("the kind question offers an outcome for none of these", () => {
  assert.deepEqual(Object.keys(QUESTION_KIND_QUESTION.criteria), [
    "runnable",
    "preference",
    "blocked",
    "none_of_these",
  ]);
  assert.equal(QUESTION_KIND_QUESTION.type, "choice");
});

test("the tool question is the manifest, described in the manifest's own words", () => {
  const question = answeringToolQuestion(MANIFEST);
  assert.deepEqual(Object.keys(question.criteria), ["postAnalytics", "siteCheck", "driveSearch", "no_tool"]);
  assert.equal(question.criteria.siteCheck, "fetches a URL and reports whether it responds");
  assert.equal(ALREADY_TRIED_QUESTION.type, "noul");
});

test("the no-tool option steps aside for a tool that is actually called that", () => {
  assert.equal(noToolOption(MANIFEST), "no_tool");
  const awkward = [{ name: "no_tool", description: "a tool someone named badly" }];
  assert.equal(noToolOption(awkward), "_no_tool");
  assert.deepEqual(Object.keys(answeringToolQuestion(awkward)), ["type", "instructions", "criteria"]);
  assert.deepEqual(Object.keys(answeringToolQuestion(awkward).criteria), ["no_tool", "_no_tool"]);
});

// ---------------------------------------------------------------------------
// The bands.
// ---------------------------------------------------------------------------

test("suppress: runnable, a real tool named, nothing tried yet", async () => {
  const outcome = await run(RUNNABLE);
  assert.equal(outcome.verdict, "suppress");
  assert.equal(outcome.kind, "runnable");
  assert.equal(outcome.tool?.name, "postAnalytics");
  assert.equal(outcome.tool?.inManifest, true);
  assert.equal(outcome.alreadyTried.value, false);
  assert.equal(outcome.alreadyTried.noul, null);
  assert.equal(outcome.reason, "run postAnalytics: the bot has a tool that answers this");
});

test("pass: a preference is the person's, and so is a block", async () => {
  const preference = await run({ ...RUNNABLE, [QUESTION_KIND_ID]: choice("preference") });
  assert.equal(preference.verdict, "pass");
  assert.match(preference.reason, /the person's call/);
  const blocked = await run({ ...RUNNABLE, [QUESTION_KIND_ID]: choice("blocked") });
  assert.equal(blocked.verdict, "pass");
  assert.match(blocked.reason, /unblock/);
});

test("pass_flagged: the judge was not sure enough to hold anything back", async () => {
  const outcome = await run({ ...RUNNABLE, [QUESTION_KIND_ID]: choice("runnable", 0.6) });
  assert.equal(outcome.band, "0to70");
  assert.equal(outcome.verdict, "pass_flagged");
  assert.equal(outcome.action, "pass_flagged");
  assert.match(outcome.reason, /not sure enough/);
});

test("pass_flagged: runnable, but the tool was already tried", async () => {
  const byCode = await run({ ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.02) }, { recent: [{ name: "postAnalytics" }] });
  assert.equal(byCode.verdict, "pass_flagged");
  assert.equal(byCode.alreadyTried.by, "code");
  assert.equal(byCode.alreadyTried.inRecentCalls, true);
  assert.match(byCode.reason, /already tried/);

  const byJudge = await run({ ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.93) }, { recent: [{ name: "driveSearch" }] });
  assert.equal(byJudge.verdict, "pass_flagged");
  assert.equal(byJudge.alreadyTried.by, "judge");
  assert.equal(byJudge.alreadyTried.inRecentCalls, false);

  const both = await run({ ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.93) }, { recent: ["postAnalytics"] });
  assert.equal(both.alreadyTried.by, "both");
});

test("pass_flagged: runnable, but no tool the manifest actually has", async () => {
  const invented = await run({ ...RUNNABLE, [ANSWERING_TOOL_ID]: choice("someOtherTool") });
  assert.equal(invented.verdict, "pass_flagged");
  assert.equal(invented.tool?.inManifest, false);
  assert.equal(invented.tool?.name, null);
  assert.match(invented.reason, /no tool in the manifest was named/);

  const none = await run({ ...RUNNABLE, [ANSWERING_TOOL_ID]: choice("no_tool") });
  assert.equal(none.verdict, "pass_flagged");
  assert.equal(none.tool?.name, null);
});

test("pass_flagged: an empty manifest can never suppress, and is never asked about", async () => {
  const outcome = await run({ [QUESTION_KIND_ID]: choice("runnable") }, { manifest: [] });
  assert.equal(outcome.verdict, "pass_flagged");
  assert.equal(outcome.tool, null);
  assert.equal(ANSWERING_TOOL_ID in outcome.answers, false);
  assert.match(outcome.reason, /none enabled/);
});

test("pass_flagged: none of the three fit", async () => {
  const outcome = await run({ ...RUNNABLE, [QUESTION_KIND_ID]: choice("none_of_these") });
  assert.equal(outcome.verdict, "pass_flagged");
  assert.equal(outcome.kind, "none_of_these");
  assert.match(outcome.reason, /none of runnable, preference or blocked/);
});

test("the verdict is code's, over answers the judge gave one at a time", () => {
  const base = { bottomBand: false, toolChosen: true, alreadyTried: false } as const;
  assert.equal(askGateVerdict({ ...base, kind: "runnable" }), "suppress");
  assert.equal(askGateVerdict({ ...base, kind: "runnable", toolChosen: false }), "pass_flagged");
  assert.equal(askGateVerdict({ ...base, kind: "runnable", alreadyTried: true }), "pass_flagged");
  assert.equal(askGateVerdict({ ...base, kind: "runnable", bottomBand: true }), "pass_flagged");
  assert.equal(askGateVerdict({ ...base, kind: "preference" }), "pass");
  assert.equal(askGateVerdict({ ...base, kind: "blocked" }), "pass");
  assert.equal(askGateVerdict({ ...base, kind: "preference", bottomBand: true }), "pass_flagged");
  assert.equal(askGateVerdict({ ...base, kind: "none_of_these" }), "pass_flagged");
  assert.equal(askGateVerdict({ ...base, kind: null }), "pass_flagged");
});

test("no answer the judge can give ends in silence", async () => {
  const kinds = ["runnable", "preference", "blocked", "none_of_these"];
  for (const kind of kinds) {
    for (const tool of ["postAnalytics", "no_tool"]) {
      for (const tried of [0.02, 0.93]) {
        const outcome = await run(
          { [QUESTION_KIND_ID]: choice(kind), [ANSWERING_TOOL_ID]: choice(tool), [ALREADY_TRIED_ID]: noul(tried) },
          { recent: ["driveSearch"] },
        );
        const silent = outcome.verdict === "suppress";
        const shouldHold = kind === "runnable" && tool === "postAnalytics" && tried < 0.7;
        assert.equal(silent, shouldHold, `${kind}/${tool}/${tried} held=${silent}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The band is not the answer.
// ---------------------------------------------------------------------------

test("a confident answer bands high whichever way it went, and the verdict is not read off it", async () => {
  // A yes-or-no's confidence is its distance from the middle, so both of these band at 90plus and
  // both come back with action "accept". The verdicts are opposite. Anything reading `action` as
  // the decision gets one of these two backwards.
  const notTried = await run({ ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.02) }, { recent: ["driveSearch"] });
  const wasTried = await run({ ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.98) }, { recent: ["driveSearch"] });
  assert.equal(notTried.action, "accept");
  assert.equal(wasTried.action, "accept");
  assert.equal(notTried.band, "90plus");
  assert.equal(wasTried.band, "90plus");
  assert.equal(notTried.verdict, "suppress");
  assert.equal(wasTried.verdict, "pass_flagged");
});

test("the weakest answer is named, so a reader knows what set the band", async () => {
  const outcome = await run({
    [QUESTION_KIND_ID]: choice("runnable", 0.99),
    [ANSWERING_TOOL_ID]: choice("postAnalytics", 0.72),
  });
  assert.deepEqual(outcome.weakest, [ANSWERING_TOOL_ID]);
  assert.equal(outcome.band, "70to90");
  assert.equal(outcome.verdict, "suppress");
  assert.deepEqual(weakestQuestions({}), []);
});

// ---------------------------------------------------------------------------
// A judge that does not answer.
// ---------------------------------------------------------------------------

test("a timeout passes the question to the person, unjudged", async () => {
  const outcome = await askGate(
    { question: QUESTION, toolManifest: MANIFEST },
    {
      policy: { "ask-gate": { ...POLICY["ask-gate"]!, timeout_ms: 5 } },
      judge: codeJudge({ delayMs: 50, answers: RUNNABLE }),
      ledger: memoryLedger(),
    },
  );
  assert.equal(outcome.error?.reason, "timeout");
  assert.equal(outcome.action, "pass");
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.kind, null);
  assert.equal(outcome.tool, null);
  assert.equal(outcome.alreadyTried.value, false);
  assert.match(outcome.reason, /unjudged/);
  assert.equal(outcome.decisions[0]?.error, "timeout");
});

test("a judge error passes the same way", async () => {
  const outcome = await askGate(
    { question: QUESTION, toolManifest: MANIFEST },
    { policy: POLICY, judge: codeJudge({ fail: "http_error" }), ledger: memoryLedger() },
  );
  assert.equal(outcome.error?.reason, "http_error");
  assert.equal(outcome.action, "pass");
  assert.equal(outcome.verdict, null);
});

test("an answer that never came back passes rather than deciding on the rest", async () => {
  const outcome = await run({ [QUESTION_KIND_ID]: choice("runnable") });
  assert.equal(outcome.error?.reason, "malformed");
  assert.equal(outcome.action, "pass");
  assert.equal(outcome.verdict, null);
});

test("a gate with no question is a programming error, not a judgment", async () => {
  await assert.rejects(
    () => askGate({ question: "  ", toolManifest: MANIFEST }, { policy: POLICY, judge: codeJudge(), ledger: memoryLedger() }),
    /needs the question/,
  );
});

test("a manifest larger than a choice can hold is refused, not silently trimmed", async () => {
  const huge = Array.from({ length: 255 }, (_unused, at) => ({ name: `tool${at}`, description: "x" }));
  await assert.rejects(
    () => askGate({ question: QUESTION, toolManifest: huge }, { policy: POLICY, judge: codeJudge(), ledger: memoryLedger() }),
    /tops out at 254/,
  );
});

// ---------------------------------------------------------------------------
// Reading what a caller happens to hold.
// ---------------------------------------------------------------------------

test("a manifest is read in whatever shape it was written", () => {
  assert.deepEqual(normaliseManifest([{ name: "a", description: "does a" }]), [{ name: "a", description: "does a" }]);
  assert.deepEqual(normaliseManifest(["a", "b"]), [
    { name: "a", description: "the a tool" },
    { name: "b", description: "the b tool" },
  ]);
  assert.deepEqual(normaliseManifest({ a: "does a" }), [{ name: "a", description: "does a" }]);
  assert.deepEqual(normaliseManifest([{ tool: "a", summary: "does a" }]), [{ name: "a", description: "does a" }]);
  assert.deepEqual(normaliseManifest([{ name: "a" }, { name: "a", description: "again" }]), [
    { name: "a", description: "the a tool" },
  ]);
  assert.deepEqual(normaliseManifest([{ description: "nameless" }]), []);
  assert.deepEqual(normaliseManifest(undefined), []);
});

test("recent calls are read for names, and the judge still sees the whole thing", () => {
  assert.deepEqual(recentToolNames([{ name: "a" }, { tool: "b" }, "c"]), ["a", "b", "c"]);
  assert.deepEqual(recentToolNames([{ name: "a", ok: false, at: 1 }]), ["a"]);
  assert.deepEqual(recentToolNames(undefined), []);
  assert.deepEqual(recentToolNames([{ nothing: true }]), []);
});

test("every question and the decision itself reach the ledger", async () => {
  const ledger = memoryLedger();
  await askGate(
    { question: QUESTION, toolManifest: MANIFEST, recentToolCalls: ["driveSearch"], context: { agentId: "a1", turnId: "t1" } },
    { policy: POLICY, judge: codeJudge({ answers: { ...RUNNABLE, [ALREADY_TRIED_ID]: noul(0.02) } }), ledger },
  );
  assert.deepEqual(ledger.rows.map((row) => (row as { question: string }).question), [
    QUESTION_KIND_ID,
    ANSWERING_TOOL_ID,
    ALREADY_TRIED_ID,
    "aggregate",
  ]);
  assert.equal((ledger.rows[0] as { answer: string }).answer, "runnable");
  assert.equal((ledger.rows[0] as { agentId: string }).agentId, "a1");
});
