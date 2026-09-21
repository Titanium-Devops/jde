# JDE, the Jev Decision Engine

One place where an agent's judgments are asked, answered, thresholded and recorded.

An agent makes a dozen decisions a turn. Is this command safe. Which model should answer.
Did that subagent actually do the work. Does this claim match its evidence. Today each of
those lives in its own file with its own thresholds and its own idea of what to do when it
is unsure, and none of them can see the others.

JDE makes them one thing:

    ask(state, questions, policy) -> { answers, action, decisions }

- **state** is what the decision is about, as data.
- **questions** are typed: a choice over your options, a yes-or-no with a probability, a
  score over your levels. The answer space is defined per call, so a new decision is a new
  question, not a new model.
- **policy** is data, not code. Per decision: the confidence bands, and what code should do
  in each. Change how cautious an agent is by editing a file.
- **decisions** are written to one ledger with their confidence, their band and the action
  taken, so a decision can be audited, marked wrong by a person, and later used as training
  data.

## Why it exists

Three properties, in the order they pay:

1. **One place to tune.** Today "act above 0.9" is a number repeated in several files.
2. **One ledger.** Every judgment an agent made, with what it did about it. That is an audit
   trail, a debugging surface, and eventually a training set.
3. **The judge is a provider.** A hosted API today, a local model later, plain code where the
   answer is a fact rather than a judgment. Swapping it is configuration.

## What is not a judgment

Facts stay in code. Whether a file exists, whether a path matches, whether a count exceeds a
budget: JDE does not ask a model what code can compute. The engine is for the semantic step
in the middle, and the harness that proved this design measured every judgment against a
blind case set written by someone who never saw the questions.

## Status

Working, one decision. The completion check, "did the agent actually do the work", answers
30 blind cases at 100 percent: every part, every verdict, every echo check, at a p50 of
171 ms and about a tenth of a cent for the run. Those cases were written by someone who
never saw the questions, and the set is run once.

Offline, 32 tests cover the bands, the aggregate, both fallbacks, the ledger shape and the
rule that a file part is decided by code alone. Not yet exercised against the live API: the
error paths, and `score` questions, which are typed and parsed but no decision asks one yet.
