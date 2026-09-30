# Bartowski Jeb 9B community quant comparison

Tested 2026-09-29 against the 36-case public completion-check set. The question is whether the
community GGUFs published by
[`bartowski/frontier-infra_jebadiah-9b-v2-GGUF`](https://huggingface.co/bartowski/frontier-infra_jebadiah-9b-v2-GGUF)
preserve the decisions made by our published Q8_0.

## Result

| Community quant | Verdict agreement with our Q8_0 | Public verdict accuracy | Mean absolute label-probability difference | ECE |
|---|---:|---:|---:|---:|
| Q4_K_M | 35 of 36, 97.22% | 30 of 36 | 0.012416 | 0.042160 |
| Q6_K | 36 of 36, 100.00% | 31 of 36 | 0.005610 | 0.041586 |
| Q8_0 | 36 of 36, 100.00% | 31 of 36 | 0.000520 | 0.042833 |

Q6_K and Q8_0 preserve every aggregate verdict on this set. Q4_K_M changes one:
`pub-imperative-echo` is `partial`, while our Q8_0 says `not_done`. Our Q8_0's ECE on the same
110 model-answered questions is 0.042648.

This is verdict parity, not probability identity. The Q6_K probabilities differ from our Q8_0 by
0.005610 on average, or 0.5610 percentage points. Bartowski's Q8_0 differs by 0.000520 on average,
or 0.0520 percentage points.

## Method

- JDE commit: `76fc057f7070fd0d7e36acad2c0eb8fdf525bbb2`
- Case set: `cases/completion-check-public.json`, sha256
  `ae6075d0de7d2126e400ae27c953e55542d8cbbe4b911a340695e3b8fb508aad`
- Community repository revision: `779478013ed48b08b6d4297ed71f90fce0108798`
- Runtime: llama.cpp 0.5.0, build 11146, commit `7fe450e19`
- Decision adapter: jebadiah-decide 0.2.0
- Calibration: applied by `jeb serve` with `choice = 1.1863`, `noul = 1.0903`, and
  `score = 0.8329`. This set uses only `noul` questions.
- Reference: `evals/results/2026-09-29-jebadiah-9b-v2-Q8_0-llama-server.json`, our published
  Q8_0 on the same runtime and case set. Its relevant `noul` temperature is also 1.0903.

Each community file was downloaded separately with `hf download --include`, loaded by
`llama-server`, evaluated with `npm run eval -- --judge jeb --concurrency 1`, unloaded, and deleted
before the next file was downloaded. The harness held its exclusive model lock and checked its
60 GB free-memory floor before every load. Observed free memory was 140 to 146 GB.

Verdict agreement compares the 36 aggregate `done`, `partial`, or `not_done` outcomes. The mean
absolute probability difference covers all 110 model-answered binary questions. ECE is expected
calibration error over those same questions, using the probability of the picked label and the
10 equal-width bins used by the Jebadiah evaluation tooling. File-part checks are deterministic
code decisions and are excluded from both probability metrics.
