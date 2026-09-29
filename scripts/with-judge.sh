#!/usr/bin/env bash
# Brings up one local Jeb, runs a command against it, and takes it down again.
#
#   scripts/with-judge.sh <ollama|llama-server> <4b|9b|27b> -- <command...>
#   scripts/with-judge.sh ollama 9b -- npm run eval:local
#
# ollama:        Ollama must be running; jeb serve pulls the Q8_0 GGUF on first use.
# llama-server:  llama.cpp 0.5.0 or later on PATH. The GGUF is JDE_GGUF, or the Q8_0 blob Ollama
#                already has (same file, same sha256), so nothing is downloaded twice.
#
# One model at a time. When JDE_MODEL_LOCK names a directory, it is taken with mkdir before loading
# and waited on if someone else holds it, and JDE_MIN_FREE_GB (default 60) must be free before the
# model loads. Both exist because a shared machine running several models at once runs out of
# memory, and the eval has no reason to be the process that does that.
set -euo pipefail

runtime="${1:?runtime: ollama or llama-server}"
size="${2:?size: 4b, 9b or 27b}"
shift 2
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "usage: $0 <ollama|llama-server> <4b|9b|27b> -- <command...>" >&2; exit 2; }

case "$size" in
  4b) repo=jebadiah-4b-v2-GGUF; stem=jebadiah-4b-v2 ;;
  9b) repo=jebadiah-9b-v2-GGUF; stem=jebadiah-9b-v2 ;;
  27b) repo=jebadiah-27b-GGUF; stem=jebadiah-27b ;;
  *) echo "size must be 4b, 9b or 27b" >&2; exit 2 ;;
esac
tag="hf.co/frontier-infra/${repo}:Q8_0"
jeb_port="${JDE_JEB_PORT:-8100}"
llama_port="${JDE_LLAMA_PORT:-8080}"
ollama_url="${OLLAMA_HOST:-http://127.0.0.1:11434}"
work="$(mktemp -d)"
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  if [ "$runtime" = ollama ]; then
    curl -s "$ollama_url/api/generate" -d "{\"model\":\"$tag\",\"keep_alive\":0}" >/dev/null 2>&1 || true
  fi
  [ -n "${JDE_MODEL_LOCK:-}" ] && [ -f "$JDE_MODEL_LOCK/owner" ] && grep -q "pid $$" "$JDE_MODEL_LOCK/owner" && rm -rf "$JDE_MODEL_LOCK"
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

free_gb() {
  if [ -r /proc/meminfo ]; then
    awk '/MemAvailable/ {print int($2 / 1048576)}' /proc/meminfo
  else
    vm_stat | awk '/Pages (free|inactive|speculative|purgeable)/ {gsub("\\.", "", $NF); n += $NF} END {print int(n * 16384 / 1e9)}'
  fi
}

if [ -n "${JDE_MODEL_LOCK:-}" ]; then
  mkdir -p "$(dirname "$JDE_MODEL_LOCK")"
  waited=0
  until mkdir "$JDE_MODEL_LOCK" 2>/dev/null; do
    [ "$waited" -ge "${JDE_LOCK_WAIT_S:-3600}" ] && { echo "the model lock $JDE_MODEL_LOCK is still held: $(cat "$JDE_MODEL_LOCK/owner" 2>/dev/null)" >&2; exit 1; }
    sleep 10; waited=$((waited + 10))
  done
  echo "jde eval ${runtime} ${size} pid $$ $(date)" > "$JDE_MODEL_LOCK/owner"
fi

need="${JDE_MIN_FREE_GB:-60}"
have="$(free_gb)"
[ "$have" -ge "$need" ] || { echo "only ${have} GB free, and ${need} GB must be free before a model loads" >&2; exit 1; }

wait_for() {
  for _ in $(seq 1 "${2:-180}"); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "nothing answered at $1" >&2; return 1
}

if [ "$runtime" = llama-server ]; then
  gguf="${JDE_GGUF:-}"
  if [ -z "$gguf" ]; then
    gguf="$(curl -s "$ollama_url/api/show" -d "{\"model\":\"$tag\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=/FROM (\S+)/.exec(JSON.parse(s).modelfile||"");process.stdout.write(m?m[1]:"")})')"
    [ -n "$gguf" ] || { echo "no GGUF: set JDE_GGUF, or ollama pull $tag first" >&2; exit 1; }
  fi
  # jeb checks that the loaded file is named as a Jebadiah GGUF, and Ollama names blobs by digest.
  ln -s "$gguf" "$work/${stem}-Q8_0.gguf"
  llama-server -m "$work/${stem}-Q8_0.gguf" -c 4096 -np 1 --host 127.0.0.1 --port "$llama_port" >"$work/llama.log" 2>&1 &
  pids+=($!)
  wait_for "http://127.0.0.1:$llama_port/health" 600 || { tail -20 "$work/llama.log" >&2; exit 1; }
  jeb serve --backend llama-server --size "$size" --url "http://127.0.0.1:$llama_port" --port "$jeb_port" --quiet >"$work/jeb.log" 2>&1 &
else
  jeb serve --backend ollama --size "$size" --port "$jeb_port" --quiet >"$work/jeb.log" 2>&1 &
fi
pids+=($!)
wait_for "http://127.0.0.1:$jeb_port/health" 1800 || { tail -20 "$work/jeb.log" >&2; exit 1; }

runtime_url="http://127.0.0.1:$llama_port"
[ "$runtime" = ollama ] && runtime_url="$ollama_url"
JDE_JEB_ENDPOINT="http://127.0.0.1:$jeb_port/v1/systemone" JDE_RUNTIME_URL="$runtime_url" "$@"
