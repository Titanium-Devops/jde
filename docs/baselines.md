# What guessing scores

Every number this repo publishes about a case set, "36 of 40", "30 of 30", is an accuracy with no
floor under it. This page puts the floor in. `scripts/baseline.mjs` reads a case file, works out
what the author actually labelled, and computes what a run would have scored without judging
anything: always answer the most common label.

```
node scripts/baseline.mjs                      # every file in cases/
node scripts/baseline.mjs --markdown           # the tables below
node scripts/baseline.mjs cases/promotable-blind.json --json
```

No key, no model, no network. The maths is in `src/baseline.ts` and `tests/baseline.test.ts` checks
it against a distribution small enough to do on paper.

## Read this first

**`addedRequirement` on the task restatement set is the weak number.** 35 of 40 is 87.5%, and
always answering `false` scores 31 of 40, or 77.5%. The judge is four cases better than a constant.
Of the 22.5 points available above the floor it takes 10, a Decision Score of **+44**. Every other
measured field on this repo sits at +83 or above. `USAGE.md` already explains why the five misses
happen and calls them a labelling disagreement; whatever the cause, this question is the one where
the recorded score is closest to answering without looking.

Nothing else is close to its baseline. The completion check's three fields are perfect against
floors of 40% to 73%, and task restatement's other three land at +83, +86 and +100.

## How the floor is computed

- **Majority-class baseline.** Always answer the label that occurs most. Its accuracy is the number
  a score has to beat to mean anything.
- **Prior Brier loss.** The jevals definition: a prior answers every item with the field's own base
  rates, and each item costs the sum over every label k of (p_k − y_k)², averaged over the items.
  It is the loss that a Decision Score of 0 corresponds to.
- **Decision Score.** 100 is perfect, 0 is no better than the base rates, negative is worse than
  them. Our recorded scores are counts of right answers rather than probabilities, so the column
  below is that scale in accuracy space: how much of the room between the majority baseline and
  100% the run took. A Decision Score against the Brier prior needs the run's own probabilities,
  which the ledger keeps and this script deliberately does not read.
- **Ranked probability score, skipped.** jevals uses RPS instead of Brier for an ordered rubric.
  One field here is ordered, `done` on the completion check, where not_done < partial < done, and a
  wrong answer of `partial` is nearer than `not_done`. Brier treats the three as unrelated, which
  costs the prior nothing it should have kept, so the 40% floor below is the right one to compare
  against. Nothing else in the sets is a rubric or a score. When one arrives, RPS goes in.
- **Where the recorded numbers come from.** `README.md` and `USAGE.md`, cited per row in the
  script. Only two of the six files have ever been run. Every denominator the script counted matches
  the denominator the docs quote, 69 parts, 149 coverage answers, 30 and 40 cases, which is the one
  cross-check available that the published scores cover these fields and no others.

## The sets

### `cases/completion-check-blind.json`

30 cases. **Meaningfully above guessing on all three fields, by the widest margin in the repo.**

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `parts[]` | part | 69 | true 38, false 31 | 55.1% | 0.495 | 69 of 69, 100.0% | +100.0 |
| `done` | case | 30 | partial 12, done 9, not_done 9 | 40.0% | 0.660 | 30 of 30, 100.0% | +100.0 |
| `result_is_echo` | case | 30 | false 22, true 8 | 73.3% | 0.391 | 30 of 30, 100.0% | +100.0 |

The three-way `done` split is close to even by construction, so the 40% floor is as low as a
three-label field gets, and 30 of 30 clears it completely. `result_is_echo` is the one to watch as
the sets grow: at 73% false, a set with fewer echoes in it would let a constant `false` look good.

### `cases/task-restatement-blind.json`

40 cases. **Above guessing on verdict, coverage and copying; only four cases above it on
`addedRequirement`.**

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `parts{}` | part | 149 | covered 128, uncovered 21 | 85.9% | 0.242 | 146 of 149, 98.0% | +85.7 |
| `verdict` | case | 40 | revise 16, accept 12, escalate 12 | 40.0% | 0.660 | 36 of 40, 90.0% | +83.3 |
| `addedRequirement` | case | 40 | false 31, true 9 | 77.5% | 0.349 | 35 of 40, 87.5% | +44.4 |
| `parrot` | case | 40 | false 28, true 12 | 70.0% | 0.420 | 40 of 40, 100.0% | +100.0 |

"146 of 149 coverage answers" is the headline that shrinks most on contact with its floor: 85.9% of
the parts are `covered`, so a constant `covered` already scores 128 of 149. 98.0% is still a real
result, it takes 86% of the available room, but it is not the 98-out-of-100 it reads as.

One footnote on the verdict row, from `out/tr-ledger-run.json`, which is not committed: a later run
of the same set on 2026-09-21 scored 33 of 40 verdicts rather than 36, a Decision Score of +70.8
instead of +83.3. The coverage, copying and added-requirement counts were identical; the difference
is entirely cases whose judge answers sit near the policy's bottom band. The verdict number moves
between runs by more than `addedRequirement`'s whole margin over guessing.

### `cases/completion-check-tuned.json`

31 cases, never run as a blind set, and it must not be: it is the set the check was tuned on.

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `part_*_done` | part | 58 | false 33, true 25 | 56.9% | 0.490 | never run | n/a |
| `result_is_echo` | case | 31 | false 25, true 6 | 80.6% | 0.312 | never run | n/a |
| `done` | case | 31 | not_done 12, done 10, partial 6, computed_by_code 3 | 38.7% | 0.699 | never run | n/a |

Its per-part question is written as one key per index, `part_0_done` through `part_3_done`; the
script pools them, because it is one question asked repeatedly. `code_expectations.claimed_parts` is
a list of part indices rather than labels and is not counted. The `done` field carries a fourth
value, `computed_by_code`, on three cases, which is a label about the harness rather than an answer;
the floor below counts it as its own class.

### `cases/ask-gate-blind.json`

40 cases, never run. **The floor is already high on two of its three fields, so plan for it.**

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `verdict` | case | 40 | runnable 16, preference 14, blocked 10 | 40.0% | 0.655 | never run | n/a |
| `tool` | case | 40 | null 24, then 9 distinct tools, none more than 4 | 60.0% | 0.614 | never run | n/a |
| `alreadyTried` | case | 40 | false 36, true 4 | 90.0% | 0.180 | never run | n/a |

`alreadyTried` cannot produce a publishable number on this set: always answering `false` scores 36
of 40. A run that reports 36 of 40 there, 90%, has matched a constant exactly, and 38 of 40, which
reads as 95%, is two cases better than one. `tool` is a ten-way field where 60% of the answers are `null`, so its
real question is whether the check picks the right tool on the 16 cases that have one.

### `cases/claim-labeling-blind.json`

40 cases, never run. **The three-way label is a fair test; the tool field is not.**

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `label` | case | 40 | guess 16, inferred 12, measured 12 | 40.0% | 0.660 | never run | n/a |
| `measurableByTool` | case | 40 | false 26, true 14 | 65.0% | 0.455 | never run | n/a |
| `tool` | case | 40 | null 26, web_search 8, drive_search 2, then four tools once each | 65.0% | 0.533 | never run | n/a |

### `cases/promotable-blind.json`

42 cases, never run, and **the cleanest set in the repo**: 21 post, 21 hold, so the floor is exactly
50% and any score above it is earned.

| Label field | Unit | Items | Distribution | Majority baseline | Prior Brier loss | Our recorded score | Decision Score |
|---|---|---:|---|---:|---:|---|---:|
| `verdict` | case | 42 | hold 21, post 21 | 50.0% | 0.500 | never run | n/a |

### `cases/playbook-catalog.json`

Not a case set, and not in the public repo: `scripts/mk-playbook-catalog.mjs` builds it locally from
the Titanium Bot community pack, whose text is not ours to publish. Where it exists it is the catalog
of installable playbooks, has no `expected` block, and the script says so rather than inventing a
mapping for it.

## What to do with this

1. Publish the baseline beside the score, every time. "36 of 40 against a 16 of 40 floor" is a
   sentence a reader can check; "36 of 40" is not.
2. A field whose floor is above about 80%, `alreadyTried` at 90%, `result_is_echo` on the tuned set
   at 81%, needs a balanced set before its score means anything, or it needs reporting per class
   rather than as one accuracy.
3. The ledger already records a confidence with every answer. Once a run's probabilities are read
   back, the Decision Score in these tables can be the real Brier one rather than its accuracy-space
   stand-in, and it will be a harder number than any of the above.
