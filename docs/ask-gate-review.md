# ask-gate: what the blind run raised

The set ran once, on 2026-09-21, against 40 cases whose author never saw the questions. Nothing was
changed after it. `cases/ask-gate-blind.json` is frozen and its recorded result stands.

The three questions were written, frozen and hashed before the file was opened, and the hash of
`src/decisions/ask-gate.ts` was taken immediately before the run and again immediately after. It did
not move: `5df179c921e1d58b50989eebd5f83c602e3b13080f2ac3abf35790ce34c8e1bf`. That guard existed
because a second agent was editing the same working copy at the time.

| | blind, 40 cases |
|---|---|
| `question_kind`, runnable or preference or blocked | **37 of 40** |
| `answering_tool`, picked from the manifest | 32 of 40 |
| `already_tried` | 33 of 40 |
| of which settled in code, no model asked | **26 of 26** |
| of which asked of the judge | 7 of 14 |
| Verdict, derived from the set's own labels | 26 of 40 |
| **Questions held back that the set sends to a person** | **1 of 28** |
| Questions sent that the set says a tool answers | 2 of 12 |
| Median latency | 140 ms |
| Cost for the whole run | $0.0015 |

Two notes on how to read that table. The verdict row is **derived**: the set labels a
classification, a tool and a boolean, and never labels a band, so the band is its own labels run
through the same rule code uses. It measures the judge with the aggregation held constant, and it
cannot tell you whether the author would have agreed with the rule. And the run was graded twice:
the first pass read zero labels, because the set calls its classification `verdict` and the harness
was looking for a band there. No judgment was asked for again; `scripts/eval.mjs --regrade` grades a
run from its own output file, and `preflight()` now refuses to spend a set it cannot read.

## 1. The band sees answers the verdict does not use

**Thirteen of the fourteen wrong verdicts are this one mechanism.** The aggregate certainty is the
lowest of all three answers. When the classification is preference or blocked, the verdict never
reads the tool pick, but the tool pick still sets the band, and a judge asked which tool answers a
question that no tool answers is rightly unsure. Its uncertainty then flags a question that should
simply have gone to the person.

The clearest case is `ask-gate-017`. The judge classified it preference at 1.00 and named no tool,
which is exactly right, and the gate flagged it anyway as "the judge was not sure enough to hold
this back". Fifteen of the forty cases came out flagged for that reason.

**Proposed, and deliberately not applied:** the bottom-band read should be over the answers the
verdict actually used, which for a preference or blocked classification is `question_kind` alone.
The counterfactual was computed from this set after the run, so it is a number this decision has
already been fitted to and it is not quoted here. Testing it needs a set written after this
proposal, by an author who has not seen this file.

## 2. Already tried: the same tool, or anything nearby

Seven of the fourteen `already_tried` answers the judge gave disagreed with the author, and all
seven went the same way: the judge said the bot had already tried, the author said it had not.

The author's convention is strict and consistent across all four cases they labelled true. Each is
the same named tool, run on this exact question, coming back without the answer: `drive_search` for
the brand guide, finding nothing; `repo_read` on a path that does not exist; `gh_issues` with the
label spelled wrong. The judge's reading is looser, and counts any recent call on the same subject:
a `web_fetch` that hit a login wall, when the question is what the password is.

It cost no verdicts directly. Six of the seven are on questions classified preference or blocked,
where the verdict never reads the answer. It did cost two verdicts indirectly, through finding 1,
by being the weakest answer and setting the band.

The convention is now written into the decision, so the next case author is told it in advance.

## 3. The spec and this set disagree about one failed attempt

The spec says a runnable question whose tool was already tried goes to the person, with the
parenthetical "a retry loop is not a reason to suppress again". Every case in this set labelled
already tried is a **first** miss, and its author's note says the opposite: "a zero-result first
query does not turn a lookup into a question for a person", "a missed first path does not justify
asking a person".

Both are right about different things. The spec is about a loop; the set is about one attempt. The
code cannot tell them apart because it holds a boolean where it wants a count, and
`recentToolCalls` carries enough to count. **Proposed, not applied:** suppress through the first
miss, flag after a threshold, and put the threshold in the policy rather than in code. This changes
four of the forty cases, which is the same reason it needs a set written after the change.

## 4. The one question that was swallowed

`ask-gate-014` asks what voice the Halden brand guide specifies. The manifest is an engineering one:
shell, git, repo_read, test_runner. The author labels it blocked, because nothing there reads a
document outside the repo. The judge classified it runnable at 0.98 and named `repo_read`, and the
gate held it back from a person.

This is the failure the spec says must not exist, and it happened once in forty. It is the same
error as the tool question's weakest slice: where the set says no tool fits, the judge picked one
anyway on six of twenty-four, and here that confidence was high enough to suppress. The set's author
saw it coming and wrote it into a sibling case: "a careless judge will call this runnable."

Nothing in code can catch it. The manifest was not empty, the tool was real and in the manifest, and
the bot had not tried it. Every fact code owns was satisfied. What was wrong was the judge's belief
about how far `repo_read` reaches, and that is a judgment.

## No returns list

Unlike the restatement set, this one does not argue with itself. Every label follows its own stated
rule: blocked is the bot lacking access to something that exists, preference is an authority, taste
or risk call no tool can make, and the four already-tried cases are all the same shape. I disagree
with the judge on `ask-gate-014` and `ask-gate-033`, not with the author.

The pair worth knowing about, because a future author will hit it, is `ask-gate-021` and
`ask-gate-033`. Both ask whether something may be published. One is preference because the person in
the room holds the authority; the other is blocked because a board outside the room has not voted.
The distinction is real and the state carries it, in the recent calls. The judge answered both at
about 0.35 confidence, which is the most honest thing it did all run.
