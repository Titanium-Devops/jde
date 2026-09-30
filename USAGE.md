# Using JDE

## Calling ask()

```ts
import { ask } from "@titanium-devops/jde";

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
| `confidence` | the aggregate confidence that this **passed**, or null when nothing was answered |
| `band` | the band that confidence landed in, read off the policy's own boundaries |
| `certainty` | how sure the judge was, whichever way it answered. Not what `action` is read off |
| `certaintyBand` | the band `certainty` lands in, for callers who escalate a judge that did not know |
| `decisions` | the rows written: one per question, then one for the decision |
| `error` | why it fell back, when it fell back |

### Which answer means it passed

A yes-or-no question does not say, by its type alone, which way is the good way. "Was part one
done?" passes on yes. "Is the result just the task restated?" passes on no. A noul question says so
with `passingAnswer`, and the confidence you get back is the probability of that answer:

```ts
{ type: "noul", instructions: "Is `claimed_result` a restatement of `task`?",
  criteria: { true: "...", false: "..." }, passingAnswer: "false" }
```

Three values. `"true"` is the default and asks whether something holds; `"false"` asks whether
something is wrong; `"either"` is for a fact code will branch on, where both answers are fine and
only the judge not knowing costs anything, and its confidence is how sure the judge was.

Get this wrong and a band cannot tell a confident pass from a confident failure: both read as high
confidence, both land in the accepting band. One run wrote 88 rows answering `false` at 0.9
confidence or better, and every one of them carried an accepting action.

`confidenceOf(answer, question)` is the one place that conversion happens. Called without the
question it reads the question as passing on `"true"`, which is right for most of them and wrong
for the rest, so pass the question. `certaintyOf(answer)` is the other number, distance from the
middle, and no band should be read off it as though it were a confidence.

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
    "timeout_ms": 2000
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
  with the floor written down where a reader can see it. Weakest means least confident that it
  passed, so one part the judge says was not done is the number the bands see.
- **`judge` is optional.** Left out, it's `jeb`: the open Jeb model behind `jeb serve` on
  `http://localhost:8100/v1/systemone` (`JDE_JEB_ENDPOINT`, `JDE_JEB_MODEL` and `JDE_JEB_API_KEY`
  change where, which and how). `jev` names TypeSafe's hosted Jev, opt in, with `TYPESAFE_API_KEY`.
  A judge that needs arguments, like `code`, is passed in by the caller. Set `timeout_ms` to your
  judge's p95: the shipped 2000 fits a local 9B, and 750 was the hosted budget.

Actions are your strings. JDE hands one back; it does not know what `accept` means.

Point at a different file with `JDE_POLICY_PATH`, or pass `{ policy }` for a book already in memory.

## The ledger

One line per question, then one for the decision, appended and never rewritten:

```json
{"id":"...","ts":"...","decision":"completion-check","question":"part_0_done","answer":"true",
 "confidence":0.94,"band":"90plus","action":"accept","judge":"jev-1.13.0","latencyMs":180,
 "agentId":"...","turnId":"..."}
```

A row's `confidence` is the confidence its `action` was taken on, which is the confidence that the
question passed. A row reading `"answer":"false"` with a high confidence is a question that passes
on `false`, not an accepted failure.

The decision's own row carries `question: "aggregate"`, the aggregate rule as its answer, and the
action code actually took. On a decision that never got an answer it is the only row there is, and
it carries the failure as `error`.

The state is never written. Not the request, not the evidence, not the claimed result.

Default path `.jde/ledger.jsonl`, moved with `JDE_LEDGER_PATH`, or pass `fileLedger(path)`,
`memoryLedger()` or `nullLedger()`.

## Reviewing a judgment

A reviewer records both halves of the answer:

```ts
await markWrong(ledger, rowId, "jason", { why: "the scan said nothing of the kind" });
await markRight(ledger, rowId, "jason");
await markReviewed(ledger, rowId, { wrong: false, by: "jason" });   // either verdict
```

or from a terminal, against a ledger file:

```
node scripts/mark-judgment.mjs --id <row id> --right --by jason --why "the file really was written"
node scripts/mark-judgment.mjs --id <row id> --wrong --by kelley
```

**Reviewed and right is a fact worth writing down.** A ledger that records only the wrong ones can
count mistakes and never divide by anything, because an unmarked row is either right or never looked
at and nothing in the file says which. `markWrong` is unchanged and writes exactly what it always
wrote; `markRight` is its other half.

A marker never edits the row it points at, and a later marker never deletes an earlier one. When a
row carries two verdicts that disagree, **the most recent one counts**, by timestamp, and by the
order they were appended when the timestamps tie. Both stay in the file, and the reader reports how
many rows were reviewed twice, so a reviewer who changed their mind is visible rather than erased.

## What the ledger can tell you

```
node scripts/calibration.mjs [--decision completion-check] [--question aggregate]
```

Reviewed judgments only, in ten bins, with the reviewed count printed beside every bin, because a
bin of four decisions and a bin of four hundred print the same percentage and only one of them is an
answer. The report ends with the smallest confidence whose pooled error is at or under 5 percent
with at least 100 reviewed judgments behind it, or a sentence saying why it cannot say.

```ts
const { join, calibration } = await calibrateLedger();
calibration.threshold;   // { confidence, reviewed, pooledError } or null
calibration.shortfall;   // why it is null, in words
```

Four rules this reader keeps:

- **An unreviewed row is not a correct row.** It is in neither the numerator nor the denominator.
- **An empty bin has no error rate**, which is not the same as an error rate of zero.
- **A fallback row is held out.** A judgment that never happened has a placeholder confidence, not a
  judge's answer, so a reviewed one is counted separately rather than dropped into the bottom bin.
- **An eval row is not a live row.** The reader reads live traffic by default and says how many it
  left out. Pass `--include eval` to look at a run.

## Eval traffic

`scripts/eval.mjs` appends every judgment it makes to `out/ledger/eval.jsonl`, which git ignores.
`--ledger <path>` moves it and `--no-ledger` discards it. The rows carry what every row carries and
no state text; the case id rides along as `turnId` so a reviewer can find the case a row judged.

The sink stamps each row `runKind: "eval"` and a `runId` naming the decision, the case set and the
moment the run started. The stamp comes from the sink rather than from each call, because a harness
that has to remember a field on every judgment will forget it on one, and an untagged eval row is
indistinguishable from a live one forever after.

**A threshold is never set on eval traffic.** A harness judges cases written to be judged, and their
difficulty is the case author's choice rather than a sample of what an agent meets. The rows are
worth keeping for latency, cost and confidence distributions, and for reviewing a run by hand; they
are not a denominator for production.

**When the file grows.** A row is about 360 bytes, so a 30 case blind run adds roughly 100 rows and
36 KB, and a run every day for a year comes to about 13 MB: `out/ledger/eval.jsonl` is append-only
forever, and nothing rotates or prunes it, on purpose. If a file ever does get in the way, rename it
rather than edit it, because every row carries the `runId` that says which run it came from and the
reader takes any path you point it at. The live ledger is the one to watch instead, since it grows
with real traffic rather than with runs.

Run it against this repo's own ledger today and it says there is nothing there: no judgment has ever
been reviewed, so there is no denominator and no threshold. That is the honest state, and it is the
reason a confidence threshold in this package is still a number someone chose rather than a number
anything measured.

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
jeb serve                            # a local Jeb, the default judge (pip install jebadiah-decide)
node scripts/eval.mjs --cases cases/completion-check-blind.json --out out/blind-run.json
# or against the hosted judge:
export TYPESAFE_API_KEY="$(...)"    # never echoed, never committed
node scripts/eval.mjs --judge jev --cases cases/completion-check-blind.json --out out/blind-run-jev.json
```

The eval reads both label shapes and converts them in code, so a blind set is never edited by hand
to fit the harness. It reports accuracy per question, accuracy per verdict, and accuracy by
confidence bucket, and it writes the raw records to `out/`, which is not committed. A decision that
does not clear its bar stays behind its flag, or stays in code.

The completion check's bar, cleared on 2026-09-20: every part, every verdict and every echo correct
on the 30 case blind set. The task restatement check's bar, measured once on 2026-09-21: 36 of 40
verdicts and 221 of 229 questions on its own 40 case blind set, written by an author who never saw
the questions. The numbers and what is behind them are at the end of this file.

**Our thresholds sit where the confidences cluster, and that is what moves a score.** Both sealed
sets were rerun five times each on 2026-09-21, identical requests, no change to the code. The judge
is not deterministic: its stated confidence moved by as much as **0.23**, a quarter of the scale,
between identical asks. Its pick never changed, across all 290 of them, because that movement never
crossed the argmax boundary. It crossed **our** 0.7 action floor nine times in 218 answers.

That is where a verdict comes from, so the restatement verdict count over five runs was 36, 33, 37,
36 and 36 of 40, and eight of its forty cases produced more than one verdict from five identical
asks. The question count did not move once. The instability is in the placement of our floors, not
in the judge: it is stable where it matters to itself and unstable where it matters to us, which is
ours to fix rather than the vendor's.

So **a verdict number is only honest with its range attached**, and any single one is worth about
four cases either way. `npm run regression` gates on the question count for that reason and prints
the verdict count without gating it.

## The completion check

```ts
import { completionCheck } from "@titanium-devops/jde";

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

`task_parts` is optional. Leave it out and the parts are read out of `task` by the extractor
below, which is what a caller with only a task string wants. Pass them and nothing is parsed.

`outcome.verdict` is `done`, `partial`, `not_done`, or null when the judge did not answer. A task
with one part is never partial. `outcome.result_is_echo` says whether the claimed result restates
the task instead of reporting an outcome; per the design note it is reported beside the verdict
rather than folded into it, and a caller that treats an echo as "not done" applies that itself.
`outcome.overclaim` names the parts the claim took credit for that the receipts do not carry.

One thing the design history gets wrong and the blind set settles: a run with no receipts at all is
not automatically a failure. A task whose only part is a reply, such as a recommendation that was
asked for, is delivered by saying it and leaves no receipt. That case is in the blind set and it is
labelled done.


## The task parts extractor

```ts
import { extractTaskParts } from "jde";

extractTaskParts(
  "Research the three managed Postgres providers, write the comparison to notes/pg-pricing.md, and tell me which to pick.",
);
// [
//   { id: "part_0", kind: "action", text: "research the three managed Postgres providers" },
//   { id: "part_1", kind: "file",   text: "write the comparison to notes/pg-pricing.md", path: "notes/pg-pricing.md" },
//   { id: "part_2", kind: "reply",  text: "state which to pick" },
// ]
```

The completion check asks one question per part of a task, so something has to produce the parts.
Nothing in a live agent did: every measured run so far used parts a person typed into a case file.
This is that missing piece, and it is a parser rather than a judgment, because a task is a sentence
somebody wrote and its parts are in the sentence.

What it reads:

| | |
|---|---|
| **file** | A path shaped token, and a verb near it that puts something there. `docs/x.md`, `report.csv`, `CHANGELOG.md`. A folder (`drafts/`) is not a file part, because no exact path can be checked against the receipts. A reading verb is not one either: "read the notes in docs/setup.md" leaves nothing at that path. |
| **action** | The task's own verbs and their objects, split on the conjunctions people actually write: "and", "then", a semicolon, a comma, a numbered or bulleted list. A named list inside one clause becomes one part per name. |
| **reply** | What is asked for with no file and no action attached: "tell me which one to pick", "recommend one", anything said to belong "in your reply". |

Order is the order they were written. A one clause task is one part, never zero. A sentence that
takes work away ("No file needed.") is dropped whole.

### What it scores, and against what

```bash
npm run build
node scripts/parts-eval.mjs                 # add --quiet for the counts alone
```

The scorer runs the extractor over the 61 tasks in `cases/completion-check-blind.json` and
`cases/completion-check-tuned.json`, whose parts were written by hand by the people who wrote those
sets, and compares part for part: the count, the kind of each, the path of each file part, and a
lenient text match that asks for the same verb and a third of the same object words.

**Those two files are a development set for the extractor, not a blind one.** They are blind to the
completion check, whose questions they were written for, and the parser was then iterated against
its score on them. Read the numbers as an upper bound. A blind set for the extractor is a fresh file
of tasks and parts written by someone who has not seen `src/parts.ts`, and it is the thing to write
before this is trusted anywhere the parts are not shown to the person who typed the task.

| | first run | after iterating |
|---|---|---|
| Exact part count | 57/61 | 57/61 |
| Count, kinds and paths all correct | 52/61 | **57/61** |
| Kind, per part | 115/129 | **120/129** |
| Path, per file part | 46/54 | **51/54** |
| Text, verb and object | 103/129 | 103/129 |

Three rules closed the gap between those columns: a clause that points back at a file the sentence
already named ("and make it skip the push") stays in that file, a sentence that asks for nothing is
context for the next one rather than a part, and a reading verb with a path is an action.

The text column did not move and is not expected to. A person writing parts by hand rewrites them
("write the price table" for "put them in data/cindermill-prices.csv"), and this keeps the words
that were typed. It costs nothing: a file part's text never reaches a model, and an action or reply
part's text is the question, where the typed words are the more literal thing to ask about.

### What it gets wrong

Written out in full at the top of `src/parts.ts`, and worth reading before trusting a split. The
four tasks it misses in the sets above are each one of them: a counted enumeration ("draft two
replies, one accepting and one asking for a lower rate"), work hidden in an adjunct ("using the
commit log"), and two tasks where the hand written parts fold a "draft it, then save it at this
path" pair into one file part while the other set's author kept both.

None of these is a case for a judge. A wrong split shows up in the ledger as a part nobody could
satisfy; a model call on every task costs money on every turn and answers the same string two ways.

## The task restatement check

```ts
import { taskRestatement } from "jde";

const outcome = await taskRestatement({
  task,
  taskParts: [              // optional, exactly as with the completion check
    { id: "p1", kind: "action", text: "research the three managed Postgres providers" },
    { id: "p2", kind: "file", text: "write the comparison", path: "notes/pg-pricing.md" },
    { id: "p3", kind: "reply", text: "state which to pick" },
  ],
  restatement,              // what the bot wrote back before it started
  loop: 0,                  // how many revise loops have already run
  context: { agentId, turnId },
});

if (outcome.verdict === "revise") redispatch(outcome.uncovered);
```

This runs before the work, where the completion check runs after. The bot writes the task back in
its own words and this says whether the restatement shows it read the request: all of it, only it,
and not by copying.

`outcome.verdict` is `accept`, `revise`, `escalate`, or null when the judge did not answer.
`uncovered` names the parts to hand back on a revise. `parrot` says whether the restatement was a
copy and which of code or the judge decided that. `similarity` is the ratio, for the ledger.

Three questions, and only three, however long the task is:

- one yes-or-no per part, on whether the restatement carries that part with the same meaning
- one yes-or-no on whether it requires something the request did not ask for
- one yes-or-no on whether it is a copy, asked only when the ratio did not already settle it

Code owns the part count, the ratio, and the verdict. `similarityRatio()` is the share of the
restatement's four word runs that appear exactly in the task; at `PARROT_RATIO_FLOOR` or above,
code calls it a copy and the question is never asked, the same way a file part never reaches a
model in the completion check.

`taskParts` is read in whatever shape it arrives: parts with ids, parts without, bare strings, or
an object keyed by part id. Leave it out and `extractTaskParts()` reads the parts out of the task,
renumbered from the extractor's `part_0` to the `p1` the case sets and the console use.

### What it scored

Measured once, on 2026-09-21, against 40 cases written by an author who never saw the questions.
No tuning after the run.

| | blind, 40 cases |
|---|---|
| Verdict: accept, revise or escalate | **36 of 40**, and 33 to 37 across five reruns |
| Coverage, one question per task part | **146 of 149** |
| Added a requirement the request did not contain | 35 of 40 |
| Is a copy, code and judge together | **40 of 40** |
| of which the ratio settled with no model at all | 11 of 11 |
| Median latency | 141 ms |
| Cost for the whole run | $0.0018 |

The copying slice is the one to read first, because it is the one code took. Every parrot in the
set scored 0.79 or above on the ratio except one, which scored 0.53 and was the paraphrase parrot
the question exists for; the judge called it at 0.83. The highest ratio any honest restatement
reached was 0.19. A floor of 0.6 sits in the middle of a gap that wide, and it was picked before
the set was opened.

Both slices that missed, missed the same way, and neither cost a verdict:

- **Coverage (3 of 149).** All three are a broad first part, such as "write a week of X posts",
  where the restatement writes them for the wrong audience. The case author calls that part covered
  and puts the error in the sibling part that carries the audience; the question, as written, calls
  a changed target uncovered. The sibling was marked uncovered by both, so the verdict held.
- **Added requirement (5 of 40).** All five are a restatement that proposes doing what the request
  forbade: posting replies that were to be left unposted, closing duplicates that were to be tagged.
  The author reads that as a part not covered, not as an addition. The question's own criteria say
  the same thing, and the judge answered otherwise on all five anyway.

Every one of the four wrong verdicts is a judge answer that landed between 0.56 and 0.69, which the
policy's bottom band escalates. Three were labelled accept and one revise. That rule is the spec's
and it stays; the eval prints how often it fired alone so a second blind set has a number to argue
with rather than a feeling.

The set is frozen and the numbers above are final. Two of its cases went back to their author for a
wrong label, and the coverage question and the added-requirement question each turned out to have a
reading the wording does not settle. Both conventions are now written into the decision's own
definition, so the next case author is told them before writing a set rather than after.
[docs/task-restatement-review.md](docs/task-restatement-review.md) has all of it, including the one
change to the escalate band that is proposed and deliberately not applied.
