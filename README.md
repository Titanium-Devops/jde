<div align="center">

# JDE

### The Jev Decision Engine

**Your AI agent says it finished. Did it?**

JDE is the layer that answers the questions your agent cannot settle with an `if`,
gives you one place to decide how much confidence is enough, and writes down every
judgment it made.

[![License: MIT](https://img.shields.io/badge/License-MIT-0EA5E9.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-0EA5E9.svg)](package.json)
[![Blind set](https://img.shields.io/badge/blind%20set-100%25-00C8F0.svg)](#the-proof)
[![Latency](https://img.shields.io/badge/p50-171ms-00C8F0.svg)](#the-proof)

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
const outcome = await ask({
  decision: "completion-check",
  state: { task, taskParts, claimedResult, receipts },
  context: { agentId, turnId },
});

if (outcome.action === "accept") deliver(result);
else redispatch(outcome.answers);          // it did not do the work, and now you know
```

Four things, each of which you would otherwise build yourself:

| | |
|---|---|
| **Typed questions** | Ask for a choice, a yes-or-no, or a score. Get a calibrated probability back, not a paragraph to parse. |
| **Policy as data** | How confident is confident enough, and what happens otherwise, lives in a JSON file. Not scattered through your code. |
| **One ledger** | Every judgment, its confidence, and what your software did about it. Auditable, and the training set for owning the judge later. |
| **Swappable judge** | A hosted decision model today. Your own fine-tuned model tomorrow. Your code where the answer turned out to be a fact. |

## The proof

The first decision shipped is the one above: *did the agent actually do the work?*

It was measured once against 30 cases written by someone who never saw the questions and
never saw a result. No tuning afterwards. That is the whole point of a blind set.

<div align="center">

| | Result |
|---|---|
| **Correct verdict** (done / partial / not done) | **30 of 30** |
| Prompt restated instead of answered, caught | **30 of 30** |
| Task parts judged against real receipts | **42 of 42** |
| Task parts settled by code, no model | **27 of 27** |
| Median latency | **171 ms** |
| Cost for the entire run | **$0.001** |

</div>

Under a fifth of a cent to check thirty agent completions, in under two seconds.

## Why it works: ask small questions

This is the lesson that produced those numbers, and it is worth more than the code.

Asking a model one question about a whole task scored **in the seventies**. Splitting the
same judgment into one question per part of the task, settling the parts that are facts in
code, and adding them up in code, scored **100 percent**.

> Give the model the semantic step in the middle. Keep the arithmetic.

Whether a file exists at a path, whether a count exceeds a budget, whether every part
passed: none of those need a model, and asking one makes them worse.

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
npm install
npm test          # 32 tests, no network, no API key
```

Everything offline runs against the `code` judge, which is a judge you hand the answers to.
You can test your policy, your thresholds and your fallbacks without a model, a key, or a
network connection.

For real judgments, set a [TypeSafe](https://typesafe.ai) key in `TYPESAFE_API_KEY`:

```bash
export TYPESAFE_API_KEY="..."
node scripts/eval.mjs --cases cases/completion-check-blind.json
```

The key is read from there and nowhere else, and never reaches the ledger.
See [USAGE.md](USAGE.md) to call `ask()`, add a decision, or write a policy entry.

## What JDE does not do

It does not generate text. It does not decide what code can compute. It does not retry a
judgment: one call, a timeout, a fallback. It does not hold your credentials.

## Where it came from

JDE was extracted from [Titanium Bot](https://titanium.bot), a hosted AI agent product where
these decisions run against real customer work every day: whether a research answer is
supported by what was actually read, whether a request is about local stores or national
prices, whether a background worker delivered or only reported.

The shape turned out to be general, so we took it out and gave it a licence.

<div align="center">

**MIT licensed** · Built by [Titanium Computing](https://titanium.bot)

</div>
