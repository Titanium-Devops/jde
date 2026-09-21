# task-restatement: what the blind run raised

The set ran once, on 2026-09-21, against 40 cases whose author never saw the questions. Nothing was
changed after it, and nothing here changes it. `cases/task-restatement-blind.json` is frozen and its
recorded result stands: 36 of 40 verdicts, 146 of 149 coverage answers, 35 of 40 on added
requirements, 40 of 40 on copying.

Three things came out of the run that are not scores. Two cases whose labels look wrong and go back
to the author. One ambiguity in the decision's own definition that the next set has to be told about
in advance. One change that is worth testing and must not be tested here.

## 1. Returns: two cases, handed back, not edited

Both are the same shape, and the set argues against itself on them rather than against a preference
of ours. Four cases in this set put a constraint inside the first part's own text and mark that part
uncovered when the restatement contradicts it. Two put a constraint inside the first part's own text
and mark it covered. Those two are the returns.

The rule the set mostly follows, stated from its own cases:

| Case | First part's text | What the restatement does | Label |
|---|---|---|---|
| 014 | Write four **X** posts for the Oakridge listing | offers X and Instagram | uncovered |
| 015 | Summarize **last quarter's** engagement | uses the last 30 days | uncovered |
| 023 | Write notes from the **vendor call, not the standup** | writes the standup | uncovered |
| 026 | Audit last month's **scheduled** posts | audits published posts | uncovered |

The two that do not follow it:

- **task-restatement-018.** `p1` is "Write a week of X posts for Lakeside Byte's **consumer line**"
  and is labelled covered. The restatement says the posts are "aimed at the IT directors we already
  sell RMM to", which is the audience the request excluded by name. The constraint is written into
  `p1`'s own text, so by the rule 014 and 026 follow, `p1` is uncovered. The sibling part `p2`
  carries the same audience constraint and is labelled uncovered, so one set of words is covered in
  one part and uncovered in another.

- **task-restatement-021.** `p1` is "Review **the existing** board deck" and is labelled covered.
  The restatement says it will "rebuild the board deck from scratch with a new narrative arc and
  fresh charts". Rebuilding from scratch is not reviewing the existing deck, and the sibling part
  `p2`, "Edit/clean the existing deck rather than replace it", is labelled uncovered on exactly that
  reading.

Neither is a hard case and neither was edited. If the author accepts them the labels change and the
recorded number does not: a frozen set that is corrected is still a set this decision has now seen,
and its score stops being evidence about these questions.

**Not returned, and worth saying so.** `task-restatement-025` looks similar and is not. Its `p1`,
"Write a one-page brief for the partners", carries no contradicted constraint; the error lives in
`p2` and `p3`, which are labelled uncovered. The label is right and the judge was wrong there. It is
the one coverage answer in the run that is a plain miss rather than a disagreement about convention.

## 2. The ambiguity: added to, or instead of

Five answers disagreed with the author on `adds_requirement`, and all five are the same question the
questions never settle. A restatement that proposes doing what the request forbade: is that a
requirement the request did not contain, or is it the relevant part not being covered?

- **016** the request says do not post the replies; the restatement publishes them.
- **022** the request says tag duplicates and do not close them; the restatement closes them.
- **026** the request says do not delete or unschedule; the restatement takes posts down.
- **023** the request asks for notes from the vendor call, not the standup; the restatement writes
  the standup.
- **015** the request asks for last quarter; the restatement uses the last 30 days.

The judge answered "added" on all five. The author answered "not added" on all five and put each one
in the part it belongs to. Both readings are defensible, and the criteria as written point at the
author's without insisting on it.

**The convention this set actually uses, which the next brief should state outright:**

> `addedRequirement` is work the restatement piles **on top of** the request. Work it proposes
> **instead of** what was asked, including doing something the request forbade to the same artifact,
> is not an addition: it is the part that asked for the other thing, uncovered.

The set follows that line consistently once it is stated. The nine cases labelled `added: true` are
all extra work volunteered on top: a second memo with a risk score, giving-tier tags nobody asked
for, extra reviewers, a QBR call to action, UCC filings nobody requested, a rerun bake-off alongside
the brief that was still written. The five above all substitute rather than add.

This cost five answers and no verdicts, because the parts absorbed it: every one of those five was
already a revise on an uncovered part. That is the aggregation working, and it is the reason this is
written down as a definition to fix rather than a defect to chase.

## 3. Proposed, and deliberately not applied

**Proposal: drop the rule that escalates on any answer in the bottom confidence band.**

Today `restatementVerdict()` escalates when the weakest answer lands in the policy's bottom band,
before it looks at coverage or additions. The spec asks for that rule and it is still in the code.

The case for changing it is that every wrong verdict in the run came from an answer between 0.56 and
0.69, and three of the four were otherwise clean restatements. The case against changing it is that
a judge which is genuinely unsure about whether a bot read its instructions is exactly the moment a
person should look, and 12 of 12 escalates in this set were right.

**This must not be tested on `cases/task-restatement-blind.json`.** The counterfactual score was
computed from that set after the run, which makes it a number this decision has already been fitted
to, and re-running against it would measure the fitting rather than the rule. Testing it needs a set
written after this proposal, by an author who has not seen this file or the run it came from. Until
that exists, the rule stays.

## What the next case author needs to be told

Not the questions, and not any result. Only the two conventions above, which are properties of the
decision rather than of its wording:

1. A part is uncovered when the restatement contradicts a constraint written into **that part's own
   text**, even when a sibling part carries the same constraint.
2. `addedRequirement` means work on top of the request. Work in place of it is an uncovered part.
