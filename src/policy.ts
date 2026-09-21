import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Answer, Answers, Band, PolicyBook, PolicyEntry } from "./types.ts";

/**
 * Policy is data. Bands, the aggregate rule, the fallback action and the deadline live in a JSON
 * file, so how cautious an agent is changes without a release.
 *
 * Two rules are enforced here rather than trusted: there is a band for every confidence including
 * the bottom, and a decision that does not answer has somewhere to fall back to. A policy that
 * breaks either is refused at load, because the alternative is a decision at 0.2 confidence
 * silently landing in whatever band happens to sort first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/policy.js and src/policy.ts both sit one directory below the package root. */
const DEFAULT_POLICY_PATH = resolve(HERE, "..", "policy.json");

const cache = new Map<string, PolicyBook>();

export function defaultPolicyPath(): string {
  return process.env.JDE_POLICY_PATH ?? DEFAULT_POLICY_PATH;
}

export function loadPolicyBook(path: string = defaultPolicyPath()): PolicyBook {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the policy file at ${path} could not be read: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`the policy file at ${path} is not an object of decision names`);
  }
  const book = raw as PolicyBook;
  for (const [decision, entry] of Object.entries(book)) validatePolicyEntry(decision, entry);
  cache.set(path, book);
  return book;
}

/** Only for tests, which write policy files into a temporary directory and read them back. */
export function forgetPolicyCache(): void {
  cache.clear();
}

export function policyFor(decision: string, book: PolicyBook): PolicyEntry {
  const entry = book[decision];
  if (entry === undefined) {
    const known = Object.keys(book).join(", ") || "none";
    throw new Error(`no policy entry for decision "${decision}". Known decisions: ${known}`);
  }
  return entry;
}

export function validatePolicyEntry(decision: string, entry: PolicyEntry): void {
  const where = `policy entry "${decision}"`;
  if (typeof entry !== "object" || entry === null) throw new Error(`${where} is not an object`);
  if (!Array.isArray(entry.bands) || entry.bands.length === 0) {
    throw new Error(`${where} has no bands. Every decision needs at least a bottom band.`);
  }
  for (const band of entry.bands) {
    if (typeof band?.at_least !== "number" || !Number.isFinite(band.at_least) || band.at_least < 0 || band.at_least > 1) {
      throw new Error(`${where} has a band whose at_least is not a number between 0 and 1`);
    }
    if (typeof band.action !== "string" || band.action.length === 0) {
      throw new Error(`${where} has a band with no action`);
    }
  }
  if (!entry.bands.some((band) => band.at_least <= 0)) {
    throw new Error(`${where} has no band at 0. There is no undefined confidence: cover the bottom.`);
  }
  if (typeof entry.on_error !== "string" || entry.on_error.length === 0) {
    throw new Error(`${where} has no on_error action. A judge that does not answer must not change what code would have done.`);
  }
  if (typeof entry.timeout_ms !== "number" || !Number.isFinite(entry.timeout_ms) || entry.timeout_ms <= 0) {
    throw new Error(`${where} has no positive timeout_ms`);
  }
  if (typeof entry.aggregate !== "string" || resolveAggregate(entry.aggregate) === undefined) {
    throw new Error(`${where} names an aggregate rule this build does not have: ${String(entry.aggregate)}`);
  }
}

/** The bands, highest first, so the first one a confidence clears is the one it lands in. */
function sortedBands(bands: readonly Band[]): readonly Band[] {
  return [...bands].sort((a, b) => b.at_least - a.at_least);
}

export interface BandHit {
  readonly band: Band;
  readonly label: string;
}

/**
 * The band a confidence falls in, and the label the ledger records. The label is read off the
 * band's own boundaries, so renumbering a policy renames its rows rather than silently reusing a
 * name for a different range.
 */
export function bandFor(confidence: number, bands: readonly Band[]): BandHit {
  const ordered = sortedBands(bands);
  const index = ordered.findIndex((band) => confidence >= band.at_least);
  const at = index === -1 ? ordered.length - 1 : index;
  const band = ordered[at] as Band;
  const above = ordered[at - 1];
  const label = above === undefined
    ? `${asPercent(band.at_least)}plus`
    : `${asPercent(band.at_least)}to${asPercent(above.at_least)}`;
  return { band, label };
}

function asPercent(value: number): string {
  return String(Math.round(value * 100));
}

/**
 * A noul's confidence is its distance from the middle, not its value: 0.02 is a confident false.
 * Every threshold in this package is a confidence, so the conversion happens here alone.
 */
export function confidenceOf(answer: Answer): number {
  if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
  return answer.confidence;
}

/** What the ledger records as the answer. Never a probability distribution, never the state. */
export function answerText(answer: Answer): string {
  if (answer.type === "noul") return answer.noul >= 0.5 ? "true" : "false";
  if (answer.type === "choice") return answer.choice;
  return String(answer.score);
}

export type AggregateRule = (answers: Answers) => number;

const ALL_AT_LEAST = /^all_(?:parts_)?at_least_(\d*\.?\d+)$/;

/**
 * Aggregation is code's job, and these are the only rules code knows. The judge is never asked
 * how its answers combine, and never sees that they were combined at all.
 */
export function resolveAggregate(name: string): AggregateRule | undefined {
  if (name === "min_confidence") return minConfidence;
  if (name === "mean_confidence") return meanConfidence;
  const atLeast = ALL_AT_LEAST.exec(name);
  if (atLeast) {
    const floor = Number(atLeast[1]);
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) return undefined;
    // The lowest answer is the decision's confidence: every question has to clear the floor, so
    // the weakest one is what the bands should see. The floor itself is the policy's business,
    // and the bands in a policy that names this rule carry the same boundary.
    return minConfidence;
  }
  return undefined;
}

/** The floor a named all_at_least rule sets, for callers that report it. */
export function aggregateFloor(name: string): number | undefined {
  const atLeast = ALL_AT_LEAST.exec(name);
  return atLeast ? Number(atLeast[1]) : undefined;
}

function minConfidence(answers: Answers): number {
  const values = Object.values(answers).map(confidenceOf);
  if (values.length === 0) return 0;
  return Math.min(...values);
}

function meanConfidence(answers: Answers): number {
  const values = Object.values(answers).map(confidenceOf);
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
