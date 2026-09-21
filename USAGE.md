# Using JDE

## Calling ask()

```ts
import { ask } from "@titanium/jde";

const outcome = await ask({
  decision: "completion-check",          // names the policy entry and every ledger row
  state: { task, task_parts, claimed_result, receipts },
  questions: {
    part_0_done: {
      type: "noul",
      instructions: "Do `receipts` show that this part was carried out: run the tests?",
      criteria: {
        true: "`receipts` carry a tool call that ran them",
        false: "nothing in `receipts` ran them, whatever `claimed_result` says",
      },
    },
  },
  context: { agentId, turnId },          // for the ledger, never sent to the judge
});

if (outcome.action === "accept") { /* ... */ }
```

What comes back:

| field | what it is |
|---|---|
| `answers` | the judge's answers, keyed by question id. Empty when it did not answer |
| `action` | what code should do: the band's action, or the policy's `on_error` |
| `confidence` | the aggregate confidence, or null when nothing was answered |
| `band` | the band that confidence landed in, read off the policy's own boundaries |
| `decisions` | the rows written: one per question, then one for the decision |
| `error` | why it fell back, when it fell back |

`ask()` does not throw for anything a judge does. A timeout, a refusal, a missing key, an answer it
cannot read: each returns the policy's `on_error` action with the failure recorded, so a judge that
is down leaves the agent doing what an agent with no judge would do. It throws only for a call or a
policy that is wrong in itself, which is a programming error rather than a judgment: an unknown
decision name, no questions, a policy with no bottom band or no fallback.

A judgment costs one call. There is no retry: the fallback for one failure and for two is the same
fallback, and a retry inside a turn spends the deadline twice.

## Writing a policy entry

`policy.json`, one entry per decision:

```json
{
  "your-decision": {
    "bands": [
      { "at_least": 0.9, "action": "accept" },
      { "at_least": 0.7, "action": "accept_with_note" },
      { "at_least": 0, "action": "fall_back" }
    ],
    "aggregate": "all_parts_at_least_0.7",
    "on_error": "fall_back",
    "timeout_ms": 750
  }
}
```

Four rules, each refused at load rather than trusted:

- **A band for every case, including the bottom.** An entry with no band at 0 is rejected. There is
  no undefined confidence.
- **`on_error` and `timeout_ms` are required.** A judge that does not answer must never change what
  the agent would otherwise have done.
- **`aggregate` names a rule this build has.** Shipped: `min_confidence` (the weakest answer is the
  decision's confidence), `mean_confidence`, and `all_parts_at_least_<x>`, which is `min_confidence`
  with the floor written down where a reader can see it.
- **`judge` is optional** and only `jev` can be named. A judge that needs arguments, like `code`, is
  passed in by the caller.

Actions are your strings. JDE hands one back; it does not know what `accept` means.

Point at a different file with `JDE_POLICY_PATH`, or pass `{ policy }` for a book already in memory.

## The ledger

One line per question, then one for the decision, appended and never rewritten:

```json
{"id":"...","ts":"...","decision":"completion-check","question":"part_0_done","answer":"true",
 "confidence":0.94,"band":"90plus","action":"accept","judge":"jev-1.13.0","latencyMs":180,
 "agentId":"...","turnId":"..."}
```

The decision's own row carries `question: "aggregate"`, the aggregate rule as its answer, and the
action code actually took. On a decision that never got an answer it is the only row there is, and
it carries the failure as `error`.

The state is never written. Not the request, not the evidence, not the claimed result. A person
marks a row wrong with `markWrong(ledger, id, by)`, which appends a marker rather than editing the
row, so the judgment and the correction both survive.

Default path `.jde/ledger.jsonl`, moved with `JDE_LEDGER_PATH`, or pass `fileLedger(path)`,
`memoryLedger()` or `nullLedger()`.

## Adding a decision

A decision is a module under `src/decisions/` that owns three things: what it asks, what it works
out in code, and what the answers add up to. `completion-check.ts` is the worked example.

1. **Decide what is not a judgment.** Whether a file exists, whether a path matches, whether a count
   exceeds a budget: compute it. The completion check settles its file parts in code and never asks
   a model about them, which is why that slice cannot be wrong for a reason a model has.
2. **Write the questions.** One question per thing you need to know, each with instructions and
   criteria for both outcomes, and an option for "none of these fit" in every choice. Name the field
   you mean, in backticks, when the state has more than one: a question that does not say which
   field reads the whole state.
3. **Do the combining yourself.** The judge answers each question knowing nothing about the others.
   Ordering, counting, comparing and adding up are code's.
4. **Add a policy entry**, with a band for every case and a fallback.
5. **Measure it twice.** See below.

```ts
export async function yourDecision(input, options = {}) {
  const outcome = await ask({ decision: "your-decision", state, questions, context }, options);
  if (outcome.error !== undefined) return { verdict: null, action: outcome.action };
  return { verdict: combineInCode(outcome.answers), action: outcome.action };
}
```

## Proving a decision before it ships

**Every new decision needs a blind case set written by someone who did not write the questions.**
Not a review of the cases, not the same person a week later: someone who has not seen the wording,
the results, or which way a case is meant to go.

Two sets, reported separately:

- a **tuned** set, which the author may iterate against, and
- a **blind** set, which runs once.

```
export TYPESAFE_API_KEY="$(...)"    # never echoed, never committed
node scripts/eval.mjs --cases cases/completion-check-blind.json --out out/blind-run.json
```

The eval reads both label shapes and converts them in code, so a blind set is never edited by hand
to fit the harness. It reports accuracy per question, accuracy per verdict, and accuracy by
confidence bucket, and it writes the raw records to `out/`, which is not committed. A decision that
does not clear its bar stays behind its flag, or stays in code.

The completion check's bar, cleared on 2026-09-20: every part, every verdict and every echo correct
on the 30 case blind set.

## The completion check

```ts
import { completionCheck } from "@titanium/jde";

const outcome = await completionCheck({
  task,
  task_parts: [
    { kind: "action", text: "search for actively maintained Node job queue libraries" },
    { kind: "file", text: "write the comparison", path: "docs/queue-options.md" },
    { kind: "reply", text: "name the recommended library" },
  ],
  claimed_result,
  receipts,                 // gathered in code from the run record, never from the agent's word
  claimed_parts: [0, 1, 2], // optional: which parts the claim says were done
  context: { agentId, turnId },
});
```

`outcome.verdict` is `done`, `partial`, `not_done`, or null when the judge did not answer. A task
with one part is never partial. `outcome.result_is_echo` says whether the claimed result restates
the task instead of reporting an outcome; per the design note it is reported beside the verdict
rather than folded into it, and a caller that treats an echo as "not done" applies that itself.
`outcome.overclaim` names the parts the claim took credit for that the receipts do not carry.

One thing the design history gets wrong and the blind set settles: a run with no receipts at all is
not automatically a failure. A task whose only part is a reply, such as a recommendation that was
asked for, is delivered by saying it and leaves no receipt. That case is in the blind set and it is
labelled done.
