# task-restatement: what the blind run raised

The set ran once, on 2026-09-21, against 40 cases whose author never saw the questions. Nothing was
changed after it, and nothing here changes it. The set is frozen, it stays private, and its recorded
result stands: 36 of 40 verdicts, 146 of 149 coverage answers, 35 of 40 on added requirements, 40 of
40 on copying.

This public copy gives the findings in aggregate. The per-case detail (task text, restatements and
labels) stays with the set, because a blind set whose cases are published stops being blind.

Three things came out of the run that are not scores. Two cases whose labels look inconsistent with
the rest of the set, handed back to its author. One ambiguity in the decision's own definition that
the next set has to be told about in advance. One change worth testing that must not be tested here.

## 1. Returns: two cases, handed back, not edited

Six cases put a constraint inside the first part's own text. Four of them mark that part uncovered
when the restatement contradicts the constraint. The other two mark it covered, while a sibling part
carrying the same constraint is marked uncovered. Those two are the returns: the set argues against
itself on them, not against a preference of ours.

Neither was edited. If the author accepts them the labels change and the recorded number does not: a
frozen set that is corrected is still a set this decision has now seen, and its score stops being
evidence about these questions.

One further coverage miss looks similar and is not: the label is right and the judge was wrong. It
is the one coverage answer in the run that is a plain miss rather than a disagreement about
convention.

## 2. The ambiguity: added to, or instead of

Five answers disagreed with the author on `adds_requirement`, and all five are the same question the
questions never settle. A restatement that proposes doing what the request forbade: is that a
requirement the request did not contain, or is it the relevant part not being covered?

The judge answered "added" on all five. The author answered "not added" on all five and put each one
in the part it belongs to. Both readings are defensible, and the criteria as written point at the
author's without insisting on it.

**The convention this set actually uses, which the next brief should state outright:**

> `addedRequirement` is work the restatement piles **on top of** the request. Work it proposes
> **instead of** what was asked, including doing something the request forbade to the same artifact,
> is not an addition: it is the part that asked for the other thing, uncovered.

The set follows that line consistently once it is stated. The nine cases labelled `added: true` are
all extra work volunteered on top of the request. The five above all substitute rather than add.

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

**This must not be tested on the task-restatement blind set.** The counterfactual score was computed
from that set after the run, which makes it a number this decision has already been fitted to, and
re-running against it would measure the fitting rather than the rule. Testing it needs a set written
after this proposal, by an author who has not seen this file or the run it came from. Until that
exists, the rule stays.

## What the next case author needs to be told

Not the questions, and not any result. Only the two conventions above, which are properties of the
decision rather than of its wording:

1. A part is uncovered when the restatement contradicts a constraint written into **that part's own
   text**, even when a sibling part carries the same constraint.
2. `addedRequirement` means work on top of the request. Work in place of it is an uncovered part.
