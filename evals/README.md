# Local-judge results

Every number in the README's proof table comes from a file in `results/`, made by
`npm run eval:local` against a Jeb on our own machine, and every one of them can be
rerun by anyone with the same GGUF.

## What was measured

Two case sets for the completion check, both in `cases/`:

| Set | Cases | What it is |
|---|---|---|
| `completion-check-public.json` | 36 | The public blind set. Written by an independent author who never saw JDE's questions or any result ([how](../cases/completion-check-public.AUTHOR.md)). Its sha256 went into `cases/SHA256SUMS` in the commit that added it, and that commit was pushed before any judge saw a case. |
| `completion-check-tuned.json` | 31 | The set the question wording was tuned against. It is shown for completeness and proves nothing on its own: a judge scored on the cases its prompt was written for is scored on homework it has already seen. |

The 30-case blind set behind JDE's first measurement is private and stays private. A blind set
that a model can train on stops measuring anything, and that one is also the reference for
Titanium Bot's production judge. The public set exists so the claim can be checked without it.

A frozen set is never edited. `eval:local` refuses to run a set whose hash no longer matches
`cases/SHA256SUMS`. When a set needs to change, a new one is written, by a new author, and frozen
before it is run.

## What each result file records

`results/<date>-<model>-<quant>-<runtime>.json`, one per model, quantization and runtime:

- **jde**: the version and commit that ran, and whether `src`, `scripts` or `cases` had uncommitted
  changes (a dirty run says so).
- **judge**: `jeb serve` and the jebadiah-decide version, the runtime and its version, the model
  tag the runtime was asked for, and the calibration temperatures jeb applied.
- **weights**: the GGUF's sha256, and the Hugging Face repo, file and revision it matches. The match
  is by content: Ollama names a blob by its sha256 and llama-server's file is hashed, then looked up
  among the published files, so a renamed or locally built file cannot pass as a published one.
- **prompt**: a hash over JDE's question wording (as it would be sent, for every case), jeb's chat
  template, its tokenizer and its temperatures. A reworded question or a new template changes it.
- **sets**: each set's path and sha256, the counts the README quotes, and every case: the labels,
  the verdict, and each answer to six decimal places.

Latency is recorded as a summary only. It is a property of the machine, not the judge.

## Reproduce it

```bash
pip install jebadiah-decide
npm ci

# One size on one runtime. with-judge.sh starts the runtime and jeb serve, runs the command,
# and stops them again.
scripts/with-judge.sh ollama 9b -- npm run eval:local
scripts/with-judge.sh llama-server 9b -- npm run eval:local   # llama.cpp 0.5.0 or later

# Rerun a committed result and fail on any difference:
scripts/with-judge.sh ollama 9b -- npm run eval:verify
scripts/verify-all.sh                                          # every committed result
```

Or bring the judge up yourself (`jeb serve --backend ollama --size 9b`) and run
`npm run eval:local` against it.

The readout is a logprob readout at temperature 0 with one request in flight, so a rerun on the
same GGUF and runtime gives the same answers to the last digit. `eval:verify` therefore allows no
difference at all by default. On our hardware the 9B gives identical answers on Ollama and on
llama-server too, though nothing promises that across runtime versions; a result is verified
against the runtime it was made on.

## Hosted Jev, for comparison

`comparison/` holds the same two sets judged by TypeSafe's hosted Jev, the judge JDE was first
measured with. It is there so the disagreements can be read case by case, not as a result: a hosted
service can change behind the same name, and nobody outside TypeSafe can rerun it at a fixed
version. It needs a key (`TYPESAFE_API_KEY`) and `node scripts/eval.mjs --judge jev`.

## CI

`.github/workflows/eval-verify.yml` runs `scripts/verify-all.sh` on our own Mac Studio for every
pull request from this repository and every push to master, one model at a time. A pull request
from a fork does not run there, because it would run that code on the machine.
