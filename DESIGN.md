# JDE design

## The call

```ts
const outcome = await jde.ask({
  decision: "completion-check",     // names the policy entry and the ledger rows
  state: { task, task_parts, claimed_result, receipts },
  questions: {...},                 // typed; see Questions
  context: { agentId, turnId },     // for the ledger, never sent to the judge
});
// outcome.action is what code should do; outcome.decisions is what was recorded.
```

## Questions

Three primitives, chosen by what the answer means:

| type | returns | use it for |
|---|---|---|
| `choice` | the option, a probability per option, a confidence | one of a defined set |
| `noul` | a probability that the answer is yes | whether a condition holds |
| `score` | a probability-weighted position on your ordered levels | a degree |

Every question carries instructions and criteria, and every set of options includes an
outcome for "none of these fit". Questions are literal: the judge answers the question as
written, not the question as meant.

## Policy

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

Rules the policy format enforces:

- **A band for every case**, including the bottom. There is no undefined confidence.
- **`on_error` and a timeout are required.** A judge that does not answer must never change
  what the agent would otherwise have done.
- **Aggregation is code's job.** When a decision is several questions, the policy says how
  they combine; the judge never sees the aggregate.

## Providers

```ts
interface Judge {
  readonly id: string;                       // recorded on every row
  ask(state, questions, signal): Promise<Answers>;
}
```

Shipped: `jev` (hosted). Planned: `local` (a fine-tuned small model), `code` (a deterministic
judge for tests and for questions that turned out to be facts).

## The ledger

One line per decision, appended, never rewritten:

```json
{"id":"...","ts":"...","decision":"completion-check","question":"part_0_done",
 "answer":"true","confidence":0.94,"band":"90plus","action":"accept",
 "judge":"jev-1.13.0","latencyMs":180,"agentId":"...","turnId":"..."}
```

Never the state. A person can mark a row wrong, which appends rather than edits:

```json
{"id":"...","wrong":true,"by":"...","ts":"..."}
```

## What JDE does not do

- It does not generate text.
- It does not decide anything code can compute.
- It does not retry a judgment. One call, a timeout, a fallback.
- It does not hold credentials. The key comes from the host's environment.

## Proving a decision before it ships

Every decision arrives with two case sets: a tuned set its author may iterate against, and a
blind set written by someone who never saw the questions or the results. The blind set runs
once. A decision that does not clear its bar stays behind its flag, or stays in code.
