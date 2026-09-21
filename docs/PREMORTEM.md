# Production pre-mortem (2026-09-21)

Hand-off for Claude Code / Grok. Assume JDE fails in production; fix P0 first.

**Repo:** `Titanium-Devops/jde` (branch `master` at review time)
**Reviewed:** `src/index.ts`, `src/policy.ts`, `src/ledger.ts`, `src/types.ts`, `src/judge/*`, `src/decisions/completion-check.ts`, `policy.json`, `tests/*`, `scripts/eval.mjs`, `cases/`, README / DESIGN / USAGE claims vs code.

---

## How to use this

1. Fix **P0** before any production agent wires on `ask().action`.
2. Prefer `completionCheck().verdict` (+ `result_is_echo`) until P0 #1 is fixed.
3. After patches: add regression tests that assert **action** and **verdict** stay aligned for confident-false nouls; re-run blind eval with a key.

---

## P0 — ships wrong decisions / silent loss

### P0-1. Noul confidence polarity inverts “done vs not done” for bands

**Where:** `src/policy.ts` — `confidenceOf`

```ts
export function confidenceOf(answer: Answer): number {
  if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
  return answer.confidence;
}
```

**What breaks:** A confident *false* (`noul: 0.05` = part not done) becomes confidence `0.95`. `bandFor` → `accept` / `accept_with_note`. `ask()` returns `action: "accept"` while every part failed.

**Evidence:**
- Per-question ledger rows use `confidenceOf` then `band.action` (`src/index.ts` success path).
- Aggregate uses `minConfidence` of those same confidences — min of “sure false” values is still high → accept.
- `completionCheck` is *safer* only if the host reads `verdict`: `partOutcomes` uses raw `noul >= COMPLETION_PART_FLOOR` (`src/decisions/completion-check.ts`). Tests assert `verdict`, not `action` (`tests/completion-check.test.ts`).

**Reproduce mentally:** one reply part, `noul: 0.11` → `verdict: "not_done"`, but `ask` aggregate confidence ≈ `0.89` → `accept_with_note`.

**Fix direction:** For decisions that mean “is it true,” band on `noul` (or on `noul` for true / `1-noul` for false *after* polarity), not on distance-from-0.5. Or stop exposing `action` as deliver/refuse until polarity is fixed. Add a unit test: confident-false must never yield accept bands.

---

### P0-2. Aggregate name `all_parts_at_least_0.7` does not enforce 0.7

**Where:** `src/policy.ts` — `resolveAggregate`

The regex parses the floor, then **returns plain `minConfidence`**. The numeric floor is unused. `aggregateFloor()` exists for reporters but `ask()` never applies it.

**What breaks:** Policy / bands can drift; the named rule stops meaning “all ≥ 0.7” if bands change. Callers reading the aggregate string are misled.

**Fix direction:** Implement `all_at_least_X` as: if any `confidenceOf(answer) < X` (or, after P0-1, any part fail), return a confidence that lands in `fall_back` (e.g. `0`), else `minConfidence`. Or rename aggregate to `min_confidence` and document that floors live only in bands.

---

### P0-3. Ledger append failures are swallowed

**Where:** `src/ledger.ts` — `fileLedger.append`

```ts
} catch {
  // A ledger write is never the reason a decision fails.
}
```

**What breaks:** Disk full, permissions, bad path → `ask()` still returns success; audit trail missing. Contradicts “one ledger / auditable.” Concurrent `chmod` after every append races.

**Also:** `src/index.ts` appends one row per question then aggregate, each independently best-effort → partial JSONL on mid-flight failure.

**Fix direction:** Surface `ledgerError` on `Outcome` (or metrics counter); optional strict mode that fails closed. Batch append one write per decision. Drop per-append `chmod` or chmod once on create.

---

### P0-4. Echo is not folded into the verdict

**Where:** `src/decisions/completion-check.ts` — `completionCheck`

Documented: “an echo is reported beside the verdict, not folded into it.” README’s “prompt restated… caught 30/30” is **echo-question accuracy**, not “we refused the deliverable.”

**What breaks:** Hosts that only check `verdict === "done"` can ship restatements when reply-parts pass against the claim text.

**Fix direction:** Document hard in USAGE: must check `result_is_echo`. Or optionally force `not_done` / non-accept action when echo ≥ floor (product decision).

---

## P1 — production incidents

### P1-1. Production timeout 750ms vs eval 30s

**Where:** `policy.json` `timeout_ms: 750`; `scripts/eval.mjs` overrides to 30000.

Flaky network → wave of `on_error: fall_back`. Fail-open is intentional; measured latency ≠ live budget.

### P1-2. `jevJudge` never retries; eval retries 5×

**Where:** `src/judge/jev.ts` (one POST); `scripts/eval.mjs` (`RETRYABLE`, `maxAttempts`).

Ops: “eval green, prod flaky.”

### P1-3. Blind 30/30 not enforced by `npm test`

Offline suite uses `codeJudge` only. Blind JSON in `cases/`; real score needs `TYPESAFE_API_KEY` + `scripts/eval.mjs`. README badge can rot.

### P1-4. License mismatch

README: MIT. `package.json`: `"license": "UNLICENSED"`.

---

## P2 — slower burn

- **Policy cache forever** (`loadPolicyBook` Map) — file edits need process restart.
- **Choice/score weak validation** (`jev.ts` `parseAnswers`) — invented choices accepted.
- **Exact path match** for file parts — brittle under agent path drift.
- Extra judge answers ignored (OK); missing one fails closed (OK).

---

## Biggest overclaim

README sells “policy thresholds + ledger decide whether to deliver.” In code, **noul polarity means bands mean “how sure,” including sure-it-failed**, not “done vs not done.” Safe path today: `completionCheck.verdict` (+ `result_is_echo`), not `ask().action`.

---

## Suggested patch order for Claude Code

1. Fix `confidenceOf` / banding for noul polarity + regression tests (P0-1).
2. Make `all_*_at_least_*` real or rename (P0-2).
3. Ledger: report write failures; atomic/batched append (P0-3).
4. USAGE + optional echo→verdict product rule (P0-4).
5. Align eval timeout story and CI blind-smoke (P1).
6. Fix LICENSE field (P1-4).
