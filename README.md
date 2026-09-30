<div align="center">

# JDE

### The Jev Decision Engine

**Your AI agent says it finished. Did it?**

JDE is the layer that answers the questions your agent cannot settle with an `if`,
gives you one place to decide how much confidence is enough, and writes down every
judgment it made.

[![License: MIT](https://img.shields.io/badge/License-MIT-0EA5E9.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-0EA5E9.svg)](package.json)
[![Public blind set](https://img.shields.io/badge/public%20blind%20set-31%2F36%20local-00C8F0.svg)](#the-proof)
[![Reproducible](https://img.shields.io/badge/eval-reproducible-00C8F0.svg)](evals/README.md)

Built at [Titanium Computing](https://titanium.bot)

</div>

---

## The problem you already have

Put an AI agent to work and it will tell you things. Some of them are true.

> "Done. I researched all five vendors and wrote the comparison."

No file was written. Two vendors were checked. The "comparison" is your own request,
rearranged into a sentence that sounds like an answer.

That is not a hypothetical. It is the single most common way an autonomous agent fails,
and it fails that way quietly, in a tone of complete confidence, in the same words it uses
when it succeeded.

**The uncomfortable part:** you cannot catch it with code. Whether a claim matches its
evidence is a judgment, not a fact. So most teams do the only obvious thing, ask a large
model in prose, parse the prose, invent a threshold on the spot, and keep no record.

That holds up until you have four such decisions. Then the same magic number lives in four
files, no two agree on what to do when the answer is uncertain, and nobody can tell you
what your agent decided yesterday or why.

## What JDE does

```ts
const check = await completionCheck({
  state: { task, taskParts, claimedResult, receipts },
  context: { agentId, turnId },
});

if (check.verdict === "done" && !check.result_is_echo.value) deliver(result);
else redispatch(check.parts);              // it did not do the work, and now you know
```

Branch on `verdict`, not on `outcome.action`. A decision's `action` comes from how *sure* the
judge was, and right now a judge that is sure a part **failed** is still a confident judge, so a
confident failure bands as `accept`. Measured on 2026-09-21: 88 of 360 ledger rows answer `false`
at 0.9 or better and every one of them carries `action: "accept"`. `verdict` reads the raw answers
and is correct on all 30 blind cases. This is being fixed; until it is, `verdict` is the field to
trust.

Four things, each of which you would otherwise build yourself:

| | |
|---|---|
| **Typed questions** | Ask for a choice, a yes-or-no, or a score. Get a calibrated probability back, not a paragraph to parse. |
| **Policy as data** | How confident is confident enough, and what happens otherwise, lives in a JSON file. Not scattered through your code. |
| **One ledger** | Every judgment, its confidence, and what your software did about it. Auditable, and the training set for owning the judge later. |
| **Swappable judge** | An open decision model on your own machine by default. A hosted one if you prefer. Your code where the answer turned out to be a fact. |

## The proof

The first decision shipped is the one above: *did the agent actually do the work?*

It is measured on a **public blind set**: 36 cases written by an independent author who never saw
JDE's questions or any result, frozen by sha256 and pushed before any judge saw a case
([how](cases/completion-check-public.AUTHOR.md)). The judge is **Jeb**, the open Jebadiah decision
model, on your own machine. Every number below is in a file under
[`evals/results`](evals/results), with the GGUF's sha256, the runtime and its version, and the
commit that ran it, and `npm run eval:verify` reruns it and fails on any difference.

<div align="center">

| Judge, on your machine | Verdict right | Parts judged right | Echo caught | Median latency |
|---|---|---|---|---|
| **Jeb 4B v2**, Q8_0 | **31 of 36** | 66 of 74 | 33 of 36 | 421 ms |
| **Jeb 9B v2**, Q8_0 | **31 of 36** | 65 of 74 | 32 of 36 | 707 ms |
| **Jeb 27B**, Q8_0 | **31 of 36** | 67 of 74 | 35 of 36 | 2.3 s |
| *For comparison: TypeSafe's hosted Jev 1.13.0* | *34 of 36* | *68 of 74* | *35 of 36* | *143 ms* |

</div>

Each size gives the same answers, to the last digit, on Ollama 0.34.4 and on llama.cpp 0.5.0, and
the same answers again on a rerun. Latency is one completion check at a time on a Mac Studio
(M3 Ultra). No cost per call, and nothing leaves the machine. Verdicts are aggregated in code from
the per-part answers; file parts are settled in code and are right by construction (19 of 19).

**Where the judges disagree.** Each local size misses five verdicts. Two misses are shared by all
three, and they are one mistake: a receipt that looks like the work is taken for the work. Search
results counted as pages read (`pub-search-without-reading`), and tests run against the wrong
service (`pub-wrong-service-tests`). 9B and 27B also accept a recommendation without the reason
that was asked for (`pub-hosting-missing-reason`), and judge two polished restatements of the task
partial rather than not done, which hosted Jev also did on the same two. 4B gets those three right
and instead calls two finished tasks partial and one restatement partial. The
hosted judge is better here, by three verdicts. It is also a service: its weights can change
behind the same name, it needs a key, and nobody outside TypeSafe can rerun it at a fixed
version, which is why it is a comparison row and not the headline.
[`evals/README.md`](evals/README.md) has the method and the case-by-case table
(`node scripts/results-table.mjs` prints it from the files).

JDE's first measurement, 30 of 30 verdicts with hosted Jev, was on a private blind set that stays
private: once a model can train on a blind set it stops measuring anything. The public set exists
so that nobody has to take that number on trust.

## Why it works: ask small questions

This is the lesson that produced those numbers, and it is worth more than the code.

On JDE's first, private blind set, with the hosted judge, asking one question about a whole
task scored **in the seventies**. Splitting the same judgment into one question per part of the
task, settling the parts that are facts in code, and adding them up in code, scored
**100 percent**. The public set above is the same shape, and it is what the local judges are
measured on.

> Give the model the semantic step in the middle. Keep the arithmetic.

Whether a file exists at a path, whether a count exceeds a budget, whether every part
passed: none of those need a model, and asking one makes them worse.

## The parts come from code too

That check asks one question per part of a task, which means something has to say what the parts
are. Nothing in a live agent did: every measured run above used parts a person typed into a case
file. `extractTaskParts()` reads them out of the sentence instead, from the paths that were typed,
the verbs that were used, and the conjunctions they were joined with. No model, no cost per turn,
and the same answer to the same string every time.

Scored against the 61 tasks whose parts were written by hand for the case sets, it gets the count,
every kind and every path right on **57**. That is a development set rather than a blind one, and
[USAGE.md](USAGE.md) has the numbers, the rules, and what it still gets wrong.

## Principles, and what they cost to learn

**A band for every case, including the bottom.** There is no undefined confidence, so there
is no path where your code does not know what to do.

**A timeout and a fallback are required, not optional.** A judge that does not answer must
never change what your agent would otherwise have done. Degrading to your old behaviour is
always allowed.

**Aggregation belongs to code.** The judge answers one thing at a time and never sees how
the answers combine.

**Facts stay in code.** If an `if` can answer it, an `if` should.

**Every new judgment needs a blind case set** written by someone who did not write the
questions. Every judgment in this engine got measurably better after a blind set caught
wording we had quietly tuned ourselves into.

## Quickstart

```bash
npm i jde
pip install jebadiah-decide && jeb serve     # the judge, on your own machine
```

```ts
import { completionCheck } from "jde";
const { verdict } = await completionCheck({ task, task_parts, claimed_result, receipts });
if (verdict === "partial" || verdict === "not_done") redo();   // null: the judge did not answer
```

`task_parts` is the task split into its parts, and `receipts` is what the run's own tool log shows
it did. [USAGE.md](USAGE.md#the-completion-check) has the shapes.

## Use it from an agent

No code: give the agent JDE as an MCP server.

```bash
claude mcp add jde -- npx -y -p jde jde-mcp
```

The agent gets `check_completion`, which its description tells it to call before it reports a task
done, and `ask` for typed questions. Cursor and other clients:
[examples/mcp](examples/mcp). In your own agent loop:
[OpenAI Agents SDK](examples/openai-agents) and [LangGraph](examples/langgraph), each checking
the run's receipts and sending the agent back when the work is not done.

## Run the tests

```bash
npm install
npm test          # no network, no API key
```

Everything offline runs against the `code` judge, which is a judge you hand the answers to.
You can test your policy, your thresholds and your fallbacks without a model, a key, or a
network connection.

## The judge

For real judgments, JDE asks **Jeb**, the open [Jebadiah](https://github.com/getainode/jebadiah)
decision model, running on your machine. Start one:

```bash
pip install jebadiah-decide
jeb serve          # Ollama by default; also LM Studio, llama.cpp, vLLM, MLX. See jeb --help
```

That serves the judge at `http://localhost:8100/v1/systemone`, which is where JDE looks by
default. No key, no account, nothing leaves the machine. Then measure it yourself:

```bash
npm run eval:local      # every public set, with full provenance, into evals/results/
npm run eval:verify     # rerun a committed result and fail on any difference
```

If nothing answers there, every decision takes its policy's `on_error` action, and the recorded
failure says how to start a local Jeb. JDE never falls back to a hosted service on its own.

| Setting | Default | |
|---|---|---|
| `JDE_JEB_ENDPOINT` | `http://localhost:8100/v1/systemone` | any `/v1/systemone` server: `jeb serve`, AINode, your own |
| `JDE_JEB_MODEL` | `jebadiah-9b-v2` | the model name sent and recorded on every ledger row |
| `JDE_JEB_API_KEY` | unset | sent as a bearer token only when set |

**Judge Jeb is coming, and isn't released yet.** It's a Jeb tuned on JDE's own judging
questions. When it ships, moving to it is the one `JDE_JEB_MODEL` setting (and loading that
model in `jeb serve` or AINode). Until then the default judge is Jeb, the general model.

**The hosted judge is opt in.** Name `"judge": "jev"` in a policy entry, or pass `jevJudge()`,
and set a [TypeSafe](https://typesafe.ai) key in `TYPESAFE_API_KEY`:

```bash
export TYPESAFE_API_KEY="..."
node scripts/eval.mjs --judge jev --cases cases/completion-check-tuned.json
```

The key is read from there and nowhere else, and never reaches the ledger.
See [USAGE.md](USAGE.md) to call `ask()`, add a decision, or write a policy entry.

## What JDE does not do

It does not generate text. It does not decide what code can compute. It does not retry a
judgment: one call, a timeout, a fallback. It does not hold your credentials. It does not call a
paid service unless you name one.

## Where it came from

JDE was extracted from [Titanium Bot](https://titanium.bot), a hosted AI agent product where
these decisions run against real customer work every day: whether a research answer is
supported by what was actually read, whether a request is about local stores or national
prices, whether a background worker delivered or only reported.

The shape turned out to be general, so we took it out and gave it a licence.

<div align="center">

**MIT licensed** · Built by [Titanium Computing](https://titanium.bot)

</div>
