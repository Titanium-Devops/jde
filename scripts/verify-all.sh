#!/usr/bin/env bash
# Reruns every committed local-judge result, one model at a time, and fails if any does not
# reproduce. This is what CI runs; it needs Ollama running, llama.cpp 0.5.0 or later, jeb and node.
#
#   scripts/verify-all.sh [evals/results/<file>.json ...]
set -euo pipefail
cd "$(dirname "$0")/.."

files=("$@")
[ "${#files[@]}" -gt 0 ] || files=(evals/results/*.json)

failed=0
for file in "${files[@]}"; do
  read -r runtime size < <(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const size = /jebadiah-(\d+b)/.exec(r.model)?.[1] ?? "";
    console.log(r.runtime, size);' "$file")
  echo "=== $file ($runtime $size)"
  if ! scripts/with-judge.sh "$runtime" "$size" -- node scripts/eval-verify.mjs --file "$file"; then
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ] || { echo "$failed result file(s) did not reproduce" >&2; exit 1; }
echo "every committed result reproduced"
