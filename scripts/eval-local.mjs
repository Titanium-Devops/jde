#!/usr/bin/env node
// The local-judge eval: every public case set, judged by the Jeb that `jeb serve` has loaded, written
// to evals/results/ with enough provenance that anyone with the same GGUF can get the same numbers.
//
// It does not start a judge. It checks that one is up, works out exactly what it is (the runtime and
// its version, the GGUF by sha256, the Hugging Face repo and revision it came from, the chat template
// and temperatures jeb applied), runs scripts/eval.mjs against each set one case at a time, and
// writes one file per model, quant and runtime.
//
// Usage: npm run eval:local -- [--sets <a.json,b.json>] [--runtime-url <url>] [--timeout-ms <n>]
//                              [--out <path>] [--date YYYY-MM-DD]
//
//   JDE_JEB_ENDPOINT   the /v1/systemone endpoint, default http://localhost:8100/v1/systemone
//   JDE_RUNTIME_URL    where the runtime behind jeb serve answers, when it is not on its usual port
//
// The readout is a logprob readout at temperature 0 with one request in flight, so a rerun on the
// same GGUF and runtime gives the same numbers to the last digit. `npm run eval:verify` holds a
// committed file to that.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { completionQuestions, JEB_ENDPOINT, questionsForWire } from "../dist/index.js";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");
export const DEFAULT_SETS = ["cases/completion-check-public.json", "cases/completion-check-tuned.json"];
export const RESULTS_DIR = "evals/results";
const HF_ORG = "frontier-infra";
const HF_REPOS = ["jebadiah-4b-v2-GGUF", "jebadiah-9b-v2-GGUF", "jebadiah-27b-GGUF"].map((r) => `${HF_ORG}/${r}`);
const RUNTIME_URLS = { ollama: "http://127.0.0.1:11434", "llama-server": "http://127.0.0.1:8080" };

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => done(hash.digest("hex"))).on("error", fail);
  });
}

async function getJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function tryRun(file, args, options = {}) {
  try {
    return (await run(file, args, { cwd: REPO, ...options })).stdout.trim();
  } catch {
    return null;
  }
}

/** The server jeb serve reports, or a message saying how to start one. */
export async function judgeHealth(endpoint) {
  const base = endpoint.replace(/\/v1\/systemone\/?$/, "");
  try {
    return { base, health: await getJson(`${base}/health`) };
  } catch (error) {
    throw new Error(
      `No judge at ${base} (${error.message}).\n` +
        "Start one, then run this again:\n" +
        "  pip install jebadiah-decide\n" +
        "  jeb serve --backend ollama --size 9b      # or --size 4b / 27b, or --backend llama-server",
    );
  }
}

/** The hash a set was frozen at, from cases/SHA256SUMS, or undefined for a set that was never frozen. */
async function frozenSha(relPath) {
  let sums = "";
  try {
    sums = await readFile(join(REPO, "cases", "SHA256SUMS"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of sums.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name && `cases/${name}` === relPath) return digest;
  }
  return undefined;
}

/** Which of the published GGUF files has this sha256, asked of the Hub rather than guessed from a name. */
async function hubFileFor(digest) {
  for (const repo of HF_REPOS) {
    try {
      const [info, tree] = await Promise.all([
        getJson(`https://huggingface.co/api/models/${repo}`),
        getJson(`https://huggingface.co/api/models/${repo}/tree/main`),
      ]);
      const file = tree.find((entry) => entry.lfs?.oid === digest);
      if (file) return { repo, file: file.path, bytes: file.size, revision: info.sha };
    } catch {
      // The Hub is unreachable or the repo moved. Provenance says so rather than inventing one.
    }
  }
  return null;
}

/** The tokenizer, chat template and temperatures jeb read, from the Hugging Face cache it read them from. */
async function jebRepoFiles(repo) {
  const hub = process.env.HF_HUB_CACHE || join(process.env.HF_HOME || join(homedir(), ".cache", "huggingface"), "hub");
  const folder = join(hub, `models--${repo.replace("/", "--")}`);
  let revision;
  try {
    revision = (await readFile(join(folder, "refs", "main"), "utf8")).trim();
  } catch {
    return { revision: null, note: `no cached snapshot of ${repo}; jeb may have read another copy` };
  }
  const files = {};
  for (const name of ["chat_template.jinja", "tokenizer.json", "temperatures.json"]) {
    try {
      files[name] = await sha256File(join(folder, "snapshots", revision, name));
    } catch {
      files[name] = null;
    }
  }
  return { revision, sha256: files };
}

/** What the runtime has loaded: its name and version, and the GGUF by content, not by filename. */
async function runtimeFacts(backend, model, runtimeUrl) {
  if (backend === "ollama") {
    const url = runtimeUrl || RUNTIME_URLS.ollama;
    const version = (await getJson(`${url}/api/version`)).version;
    const show = await getJson(`${url}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
    const from = show.modelfile.split("\n").find((line) => line.startsWith("FROM "))?.slice(5).trim() ?? "";
    // Ollama stores a blob under its own sha256, so the name is the digest.
    const digest = /sha256-([0-9a-f]{64})$/.exec(from)?.[1] ?? null;
    return { runtime: "ollama", runtime_version: version, runtime_model: model, gguf_sha256: digest, quant: show.details?.quantization_level ?? null };
  }
  if (backend === "llama-server") {
    const url = runtimeUrl || RUNTIME_URLS["llama-server"];
    const props = await getJson(`${url}/props`);
    const path = String(props.model_path ?? "");
    const version = props.build_info ?? (await tryRun("llama-server", ["--version"]))?.split("\n").find((l) => l.startsWith("version")) ?? null;
    return { runtime: "llama-server", runtime_version: version, runtime_model: basename(path), gguf_sha256: path ? await sha256File(path) : null, quant: null };
  }
  throw new Error(`eval:local reads provenance from ollama and llama-server; jeb serve is using ${backend}`);
}

/** Everything a stranger needs to get the same numbers, gathered before the first case is run. */
export async function provenance({ endpoint, runtimeUrl, setPaths }) {
  const { health } = await judgeHealth(endpoint);
  const facts = await runtimeFacts(health.backend, health.model, runtimeUrl);
  const hub = facts.gguf_sha256 ? await hubFileFor(facts.gguf_sha256) : null;
  const quant = facts.quant ?? /-(Q\d\w*|F16|BF16)\.gguf$/i.exec(hub?.file ?? "")?.[1] ?? "unknown";
  const model = hub ? hub.repo.split("/")[1].replace(/-GGUF$/, "") : "unknown";

  const commit = await tryRun("git", ["rev-parse", "HEAD"]);
  const dirty = await tryRun("git", ["status", "--porcelain", "--", "src", "scripts", "cases", "package.json", "policy.json"]);
  const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  const jebVersion = (await tryRun("jeb", ["--version"]))?.replace(/^jeb\s+/, "") ?? null;

  // The prompt is JDE's question wording plus jeb's chat template, tokenizer and temperatures. The wording is
  // hashed from what would be sent, so a reworded question cannot keep an old hash.
  const sets = [];
  const questionSets = [];
  for (const path of setPaths) {
    const text = await readFile(resolve(REPO, path), "utf8");
    const cases = JSON.parse(text);
    for (const testCase of Array.isArray(cases) ? cases : cases.cases) questionSets.push(questionsForWire(completionQuestions(testCase.state.task_parts)));
    const rel = relative(REPO, resolve(REPO, path));
    const frozen = await frozenSha(rel);
    if (frozen !== undefined && frozen !== sha256(text)) {
      throw new Error(`${rel} does not match its frozen sha256 in cases/SHA256SUMS. A frozen set is never edited; write a new one.`);
    }
    sets.push({ path: rel, sha256: sha256(text), frozen: frozen !== undefined, cases: (Array.isArray(cases) ? cases : cases.cases).length });
  }
  const jebRepo = hub?.repo ?? null;
  const jebFiles = jebRepo ? await jebRepoFiles(jebRepo) : { revision: null };
  const questionsSha = sha256(JSON.stringify(questionSets));
  const promptSha = sha256(JSON.stringify([questionsSha, jebFiles.sha256?.["chat_template.jinja"] ?? null, jebFiles.sha256?.["tokenizer.json"] ?? null, health.calibration ?? null]));

  return {
    model,
    quant,
    runtime: facts.runtime,
    jde: { version: pkg.version, commit, dirty: Boolean(dirty) },
    judge: {
      server: "jeb serve",
      jebadiah_decide: jebVersion,
      backend: health.backend,
      runtime_version: facts.runtime_version,
      runtime_model: facts.runtime_model,
      calibration: health.calibration ?? null,
    },
    weights: {
      gguf_sha256: facts.gguf_sha256,
      hf_repo: hub?.repo ?? null,
      hf_file: hub?.file ?? null,
      hf_revision: hub?.revision ?? null,
      bytes: hub?.bytes ?? null,
      matched_on_hub: Boolean(hub),
    },
    prompt: {
      sha256: promptSha,
      questions_sha256: questionsSha,
      jeb_repo_revision: jebFiles.revision,
      jeb_repo_files_sha256: jebFiles.sha256 ?? null,
    },
    host: { platform: process.platform, arch: process.arch, node: process.version },
    sets,
  };
}

/** One set through scripts/eval.mjs, one case at a time. Returns its raw output. */
export async function evalSet(path, { model, timeoutMs }) {
  const out = join(tmpdir(), `jde-eval-${process.pid}-${basename(path)}`);
  const args = [join(REPO, "scripts/eval.mjs"), "--cases", resolve(REPO, path), "--out", out, "--concurrency", "1", "--timeout-ms", String(timeoutMs)];
  try {
    await run(process.execPath, args, { cwd: REPO, env: { ...process.env, JDE_JEB_MODEL: model }, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`eval.mjs failed on ${path}: ${error.stderr || error.message}`);
  }
  const raw = JSON.parse(await readFile(out, "utf8"));
  await rm(out, { force: true });
  return raw;
}

/**
 * What is kept of a run: every answer to the digit, every grade, every verdict. Latency and ledger
 * ids are dropped from the record, since neither is a property of the judge, and the timing is kept
 * once, as a summary.
 */
export function slim(raw) {
  const records = raw.records.map((r) => ({
    id: r.id,
    labels: { parts: r.labels.parts, done: r.labels.done, echo: r.labels.echo },
    verdict: r.outcome.verdict ?? null,
    action: r.outcome.action,
    answers: Object.fromEntries(Object.entries(r.outcome.answers ?? {}).map(([id, a]) => [id, a.noul ?? a])),
    parts: (r.outcome.parts ?? []).map((p) => (p.kind === "file" ? { kind: p.kind, passes: p.passes } : { kind: p.kind, passes: p.passes, noul: p.noul })),
    error: r.outcome.error?.reason ?? null,
    correct: r.verdict.correct,
    wrong: r.grades.filter((g) => !g.correct).map((g) => g.question),
  }));
  const latencies = raw.records.filter((r) => r.outcome.error === undefined).map((r) => r.outcome.latencyMs).sort((a, b) => a - b);
  const at = (p) => (latencies.length === 0 ? null : latencies[Math.min(Math.max(Math.ceil(p * latencies.length), 1), latencies.length) - 1]);
  return { summary: summarize(raw.records), latency_ms: { p50: at(0.5), p95: at(0.95) }, report: raw.report, records };
}

/** The numbers the README quotes, counted from the records rather than copied from the report. */
export function summarize(records) {
  const grades = records.flatMap((r) => r.grades);
  const count = (rows) => ({ correct: rows.filter((g) => g.correct).length, of: rows.length });
  const scored = records.filter((r) => r.verdict.scored);
  return {
    cases: records.length,
    verdict: { correct: scored.filter((r) => r.verdict.correct).length, of: scored.length },
    judged_parts: count(grades.filter((g) => g.by === "judge" && g.kind !== "echo")),
    code_parts: count(grades.filter((g) => g.kind === "file")),
    echo: count(grades.filter((g) => g.kind === "echo")),
    unanswered: records.filter((r) => r.outcome.error !== undefined).length,
  };
}

export function resultName(prov, date) {
  return `${date}-${prov.model}-${prov.quant}-${prov.runtime}.json`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : args[at + 1];
  };
  const endpoint = process.env.JDE_JEB_ENDPOINT || JEB_ENDPOINT;
  const setPaths = flag("--sets", DEFAULT_SETS.join(",")).split(",");
  const timeoutMs = Number(flag("--timeout-ms", 120000));
  const date = flag("--date", new Date().toISOString().slice(0, 10));

  let prov;
  try {
    prov = await provenance({ endpoint, runtimeUrl: flag("--runtime-url", process.env.JDE_RUNTIME_URL), setPaths });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (prov.jde.dirty) console.error("warning: src, scripts or cases have uncommitted changes, so jde.commit does not describe this run");
  if (!prov.weights.matched_on_hub) console.error("warning: this GGUF is not one of the published Jebadiah files, or the Hub could not be reached");

  console.log(`judge: ${prov.model} ${prov.quant} on ${prov.runtime} ${prov.judge.runtime_version}, gguf ${prov.weights.gguf_sha256?.slice(0, 12)}`);
  const sets = [];
  for (const set of prov.sets) {
    const raw = await evalSet(set.path, { model: prov.model, timeoutMs });
    const kept = slim(raw);
    const s = kept.summary;
    console.log(`${set.path}: verdicts ${s.verdict.correct}/${s.verdict.of}, judged parts ${s.judged_parts.correct}/${s.judged_parts.of}, echo ${s.echo.correct}/${s.echo.of}, p50 ${kept.latency_ms.p50} ms`);
    if (s.unanswered > 0) {
      console.error(`${s.unanswered} case(s) got no answer from the judge; not writing a result that would read as a score`);
      process.exit(1);
    }
    sets.push({ ...set, ...kept });
  }

  const outPath = resolve(REPO, flag("--out", join(RESULTS_DIR, resultName(prov, date))));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ schema: "jde-eval-local/1", ran_on: date, ...prov, sets }, null, 2)}\n`);
  console.log(`written to ${relative(REPO, outPath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
