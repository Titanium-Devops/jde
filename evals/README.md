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

## The numbers

Printed by `node scripts/results-table.mjs` from the files, not typed.

### Public set

| Judge | Verdict right | Parts judged right | Echo caught | Median latency | Runs on |
|---|---|---|---|---|---|
| **Jeb 4B v2** Q8_0, local | **31 of 36** | 66 of 74 | 33 of 36 | 421 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| **Jeb 9B v2** Q8_0, local | **31 of 36** | 65 of 74 | 32 of 36 | 707 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| **Jeb 27B** Q8_0, local | **31 of 36** | 67 of 74 | 35 of 36 | 2309 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| *For comparison: hosted Jev (1.13.0)* | *34 of 36* | *68 of 74* | *35 of 36* | *143 ms* | *TypeSafe's API* |

| Case | Labelled | Jeb 4B v2 | Jeb 9B v2 | Jeb 27B | Jev |
|---|---|---|---|---|---|
| `pub-orders-export` | done | **partial** | done | done | done |
| `pub-timeout-root-cause` | done | **partial** | done | done | done |
| `pub-hosting-missing-reason` | partial | partial | **done** | **done** | partial |
| `pub-search-without-reading` | partial | **done** | **done** | **done** | partial |
| `pub-imperative-echo` | not_done | **partial** | not_done | not_done | not_done |
| `pub-empty-brief-echo` | not_done | not_done | **partial** | **partial** | **partial** |
| `pub-results-only-echo` | not_done | not_done | **partial** | **partial** | **partial** |
| `pub-wrong-service-tests` | not_done | **partial** | **partial** | **partial** | not_done |

### Tuned set, for completeness

| Judge | Verdict right | Parts judged right | Echo caught | Median latency | Runs on |
|---|---|---|---|---|---|
| **Jeb 4B v2** Q8_0, local | **24 of 28** | 25 of 31 | 28 of 31 | 279 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| **Jeb 9B v2** Q8_0, local | **24 of 28** | 25 of 31 | 28 of 31 | 476 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| **Jeb 27B** Q8_0, local | **24 of 28** | 28 of 31 | 29 of 31 | 1530 ms | llama-server b11146-7fe450e19, ollama 0.34.4 (identical answers) |
| *For comparison: hosted Jev (1.13.0)* | *27 of 28* | *30 of 31* | *31 of 31* | *131 ms* | *TypeSafe's API* |

| Case | Labelled | Jeb 4B v2 | Jeb 9B v2 | Jeb 27B | Jev |
|---|---|---|---|---|---|
| `j5-research-partial` | partial | **done** | **done** | **done** | partial |
| `j5-research-overclaim-sources` | partial | **done** | **done** | **done** | **done** |
| `j5-research-recorder-gap` | computed_by_code | **not_done** | **not_done** | **not_done** | **not_done** |
| `j5-browser-done` | done | **partial** | done | **not_done** | done |
| `j5-browser-partial` | partial | partial | partial | **not_done** | partial |
| `j5-browser-searched-instead` | not_done | not_done | **partial** | not_done | not_done |
| `j5-browser-recorder-gap` | computed_by_code | **not_done** | **not_done** | **not_done** | **not_done** |
| `j5-code-receipts-conflict` | computed_by_code | **not_done** | **not_done** | **not_done** | **not_done** |
| `j5-email-in-reply` | done | **not_done** | **not_done** | done | done |

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

## Before a merge

This repository is public, and our CI does not run on GitHub's machines, so no hosted job reruns
these files. Instead, every pull request that touches `src`, `scripts`, `cases` or `evals` is
merged only after `scripts/verify-all.sh` has reproduced every committed result on the maintainer's
machine, and the pull request says so. Anyone can run the same check: it needs Ollama,
llama.cpp 0.5.0 or later, `jeb` and the three Q8_0 GGUFs (about 44 GB).
