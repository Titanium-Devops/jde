# Anything code settles is invisible to the policy layer

Filed 2026-09-21, after the confidence polarity fix (`1e512c4`). Not fixed, on purpose. This is a
note about a shape every decision in this package will have, not a bug in one of them.

## What was measured

Both recorded blind runs were replayed offline through the fixed code, using the answers the judge
had already given. No case file was opened and no judge was called, so nothing here is subject to
the run-to-run confidence drift.

After the fix, a decision's banded `action` and its own `verdict` still disagree:

| decision | cases | disagreeing | what every one of them is |
|---|---|---|---|
| completion-check | 30 | **6** | a **file part** the receipts do not carry |
| task-restatement | 40 | **11** | a **parrot settled by the ratio in code** |

Both read `accept` while the decision's own verdict says `partial` or `escalate`.

The polarity fix closed the rest. Of the 21 completion-check cases whose verdict was `partial` or
`not_done`, all 21 carried an accepting action before; 6 do now, and those 6 were never a polarity
problem. Every disagreement traceable to a judged answer is gone.

## Why

`ask()` aggregates the answers a judge returned. That is all it has. Both decisions deliberately
keep facts away from the judge, and the rule they follow is the package's own:

- `completion-check` decides a `file` part in code, from the receipts. "The path was written, or it
  was not, and it was not empty. Code knows that from the receipts, so no model is asked and no
  confidence is involved."
- `task-restatement` decides a parrot in code when `similarityRatio()` clears `PARROT_RATIO_FLOOR`,
  and then does not ask `is_parrot` at all.

So a task that failed on nothing but its file part has a flawless set of judged answers, and a
restatement that is a verbatim copy has no answer recording that at all. The aggregate sees a clean
sheet and bands `accept`. The verdict, computed afterwards in code over everything the decision
knows, says otherwise. Both are behaving as written.

All 11 task-restatement cases were settled by the ratio; none by the judge. The judged path is
sound. It is the unjudged path that never reaches a band.

## Why it matters beyond these two

The aggregate is a function of **what the judge happened to be asked**, not of **what the decision
knows**. "Code settles what it can" is our own rule, applied deliberately and in more places as
decisions get better, so every decision we add inherits this. Each time code takes a question away
from the judge, which is the improvement we want, it also takes that question away from the
policy layer, silently. The better a decision gets, the less its action reflects it.

It is also invisible from the ledger. The rows say every question was answered well, because every
question that was asked was. Nothing records that the decision failed on something nobody asked.

## What fixing it would mean

Code-owned outcomes reaching the aggregate: a decision hands `ask()` the things it settled itself,
as answers of the same shape, so the bands see the whole decision and not the judged part of it.
That is a change to `ask()` and to `AskInput`, and it touches the ledger's row set, since a
code-settled outcome would want a row saying code settled it. It is not a change to `confidenceOf`,
which is now correct.

It should be designed rather than patched, because it decides what a confidence means for a fact:
a file either exists or does not, and giving that 1.0 makes the aggregate's minimum meaningful
while making "confidence" mean two different things in one column.

## The related trap, in the same area

`resolveAggregate()` parses the floor out of a named `all_at_least` rule and then returns plain
`minConfidence`. The floor is never applied. `aggregateFloor()` exists, is exported, and is called
from nowhere in the decision path, only from `floorFor()`, which is itself called by nobody.

The two shipped policies enforce their floor anyway, because both name `all_parts_at_least_0.7` and
both happen to have a band boundary at exactly 0.7, so the bands do the work. That is a
coincidence of configuration and not a mechanism.

A policy naming `all_parts_at_least_0.9` with bands at 0.9 / 0.7 / 0 would accept a decision whose
weakest part was 0.75. It would load without complaint, the rule's name would say 0.9, the ledger
would record the floor's name on every aggregate row, and nothing anywhere would say the floor was
not applied. The name is the documentation, and it is currently not the behaviour.

Either apply the floor in the rule, or refuse at load a policy whose named floor is not also a band
boundary. Both are small. Neither was done here, because either one changes what the shipped
policies record and both blind sets were frozen for this pass.
