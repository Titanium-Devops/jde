# JDE, the Jev Decision Engine

**Your agent makes a dozen judgment calls a turn. This is one place to ask them, one rule for
what to do with the answer, and one record of what it decided.**

```ts
const outcome = await ask({
  decision: "completion-check",
  state: { task, taskParts, claimedResult, receipts },
  context: { agentId, turnId },
});

if (outcome.action === "accept") deliver(result);
else redispatch(outcome.answers);
```

## The problem

An agent that does real work is constantly deciding things that are not facts:

- A background worker reports "done". Did it actually do the work, or restate the task?
- The reply says "nobody sells this". Does the evidence gathered support that?
- The person asked for something local. Is this a local question or a price question?
- This command looks risky. Is it?

None of those can be settled by an `if`. They are judgments, and most codebases end up
answering them by asking a large language model to reply in prose and then parsing the prose,
with a threshold invented on the spot and no record of what was decided.

That works until you have four of them. Then the same magic number lives in four files, no
two of them agree on what to do when the answer is uncertain, and nobody can tell you what
your agent decided yesterday or why.

## The idea

Ask the judgment as a **typed question** to a model that returns a **calibrated probability**
instead of prose. Keep the threshold and the policy in **data**. Write every decision to
**one ledger**. Make the judge a **provider** so it can be swapped.

```
ask(state, questions, policy) -> { answers, action, decisions }
```

### Questions are typed

Three primitives, chosen by what the answer means:

| type | you get back | use it for |
|---|---|---|
| `choice` | the selected option, a probability for each, a confidence | one of a defined set |
| `noul` | a probability that the answer is yes | whether a condition holds |
| `score` | a weighted position on your ordered levels, and a confidence | a degree |

The options are defined per call, so a new judgment is a new question rather than a new
model. Always include an option for "none of these fit". Write the question literally: the
judge answers what you wrote, not what you meant.

### Policy is data

```json
{
  "completion-check": {
    "bands": [
      { "at_least": 0.9, "action": "accept" },
      { "at_least": 0.7, "action": "accept_with_note" },
      { "at_least": 0,   "action": "fall_back" }
    ],
    "aggregate": "all_parts_at_least_0.7",
    "on_error": "fall_back",
    "timeout_ms": 750
  }
}
```

Three rules the format enforces, each of them learned the hard way:

- **A band for every case, including the bottom.** There is no undefined confidence, so there
  is no path where the code does not know what to do.
- **A timeout and an `on_error` are required.** A judge that does not answer must never change
  what your agent would otherwise have done. Degrading to the old behaviour is always allowed.
- **Aggregation happens in code.** When a decision is several questions, the policy says how
  they combine and the judge never sees the combination.

### One ledger

One appended line per question. Never the state.

```json
{"id":"...","ts":"...","decision":"completion-check","question":"part_0_done",
 "answer":"true","confidence":0.94,"band":"90plus","action":"accept",
 "judge":"jev-1.13.0","latencyMs":180}
```

Marking a decision wrong appends a row rather than editing one, so the history stays intact.
That ledger is an audit trail today and a training set later.

## Ask several small questions, not one big one

This is the single most useful thing we learned building it, and it is why the numbers below
look the way they do.

Asking one model one question about a whole task scored in the seventies. Splitting the same
judgment into one question per part of the task, deciding the parts that are facts in code,
and adding the parts up in code, scored 100 percent on cases the author had never seen.

So: **give the model the semantic step in the middle, and keep the arithmetic.** Whether a
file exists at a path, whether a count exceeds a budget, whether every part passed: none of
those need a model, and asking one makes them worse.

## The first decision: did the agent actually do the work

Background agents fail in a particular way. They report success, produce no files, and hand
back a restatement of the prompt. JDE's first decision catches that:

1. Code splits the task into parts and types each one: a **file** to write, an **action** to
   take, or something that must appear in the **reply**.
2. File parts are decided by code alone: the exact path, non-empty. No model.
3. Each action part gets one yes-or-no against the receipts, the tool calls and files and
   searches that actually happened. Each reply part gets one against what was claimed.
4. One more question asks whether the claimed result is just the prompt restated.
5. Code aggregates: every part passed is `done`, none is `not_done`, otherwise `partial`.

Measured once on 30 cases written by someone who never saw the questions:

| | |
|---|---|
| Parts decided in code | 27 of 27 |
| Parts judged against receipts | 23 of 23 |
| Parts judged against the claim | 19 of 19 |
| Verdict: done, partial, not done | 30 of 30 |
| Prompt restated instead of answered | 30 of 30 |
| Latency | p50 171 ms, p95 331 ms |
| Cost for the whole run | about $0.001 |

## Quickstart

```bash
npm install
npm test            # 32 offline tests, no network, no key
```

Everything offline runs against the `code` judge, which is a judge you hand the answers to.
That is the point: you can test your policy, your aggregation and your fallbacks without a
model or a network.

To ask a real judgment you need a [TypeSafe](https://typesafe.ai) key in `TYPESAFE_API_KEY`.
The key is read there and nowhere else, and never reaches the ledger.

```bash
export TYPESAFE_API_KEY="..."
node scripts/eval.mjs --cases cases/completion-check-blind.json
```

`USAGE.md` covers calling `ask()`, adding a decision, and writing a policy entry.

## Adding a decision

1. Write the questions. Small, literal, each with an outcome for "none of these".
2. Decide what code owns. If an `if` can answer it, an `if` should.
3. Write the policy entry: the bands, what happens in each, the timeout, the error behaviour.
4. **Write a tuned case set, then have someone else write a blind one** without seeing your
   questions or your results. Run the blind set once. If it does not clear your bar, the
   decision stays behind a flag or stays in code.

That last step is not ceremony. Every judgment in this engine got noticeably better after a
blind set caught wording we had quietly tuned ourselves into.

## What it does not do

- It does not generate text.
- It does not decide anything code can compute.
- It does not retry a judgment. One call, a timeout, a fallback.
- It does not hold credentials.

## Judges

| judge | what it is |
|---|---|
| `jev` | TypeSafe's hosted decision model, the default |
| `code` | a judge you hand answers to, for tests |
| `local` | planned: a small open-weight model fine-tuned on a ledger |

We measured an open-weight typed-judgment model against the same blind sets. Out of the box
it landed on the majority baseline on the judgment that mattered most, and never produced a
confidence high enough for our thresholds to fire. Fine-tuning one on a real ledger is the
path, which is part of why the ledger format is what it is.

## Status

Working, one decision, not yet published to npm. Exercised against the live API: the happy
path and the completion check. Not yet exercised against it: the error paths, which are
covered offline, and `score` questions, which are typed and parsed but which no decision asks
yet.

MIT licensed. Built at [Titanium Computing](https://titanium.bot) for the agents behind
Titanium Bot, and extracted because the shape turned out to be general.
