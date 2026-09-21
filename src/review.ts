import { readLedger } from "./ledger.ts";
import type { LedgerRow, ReviewMarker } from "./types.ts";

/**
 * Reading the ledger back: which judgments a person reviewed, and what that says about where the
 * confidence can be trusted.
 *
 * The ledger records a confidence for every judgment and, on its own, nothing about whether the
 * judgment was right. Confidence without correctness cannot set a threshold: 10,000 rows at 0.95
 * say only that the judge was sure 10,000 times. What a threshold needs is reviewed-and-wrong over
 * reviewed-total, and the second number is the one a ledger of wrong markers alone can never give,
 * because an unmarked row is either right or never looked at and there is no way to tell which.
 *
 * So the rule the whole of this file rests on: **an unreviewed row is not a correct row.** It is
 * not in the numerator and it is not in the denominator. It is not evidence of anything.
 *
 * ## Two markers on one row
 *
 * The last marker wins, by its timestamp, and by the order it was appended when timestamps tie.
 * Nothing is deleted: the earlier verdict stays in the file and `all` on the joined row carries
 * every marker it had, so a reviewer who changed their mind is visible rather than erased. Last one
 * wins because a review is a person's current judgment of a row, and the alternative, counting a
 * row twice on both sides, makes a denominator that is not a count of decisions.
 */

/** One judgment and the verdict a person gave it. */
export interface ReviewedRow {
  readonly row: LedgerRow;
  /** The marker that counts: the most recent one. */
  readonly review: ReviewMarker;
  /** Every marker on this row, oldest first. More than one means someone changed their mind. */
  readonly all: readonly ReviewMarker[];
}

export interface LedgerEntries {
  readonly rows: readonly LedgerRow[];
  readonly markers: readonly ReviewMarker[];
  /** Lines that are neither, which a reader counts rather than guesses about. */
  readonly unreadable: number;
}

export interface JoinOptions {
  /** Only this decision. */
  readonly decision?: string;
  /** Only this question id, such as "aggregate" or "part_0_done". */
  readonly question?: string;
  /**
   * Which traffic to read. Live by default, which is the only kind a threshold may be set on: a
   * harness judges cases written to be judged, and their difficulty is the case author's choice
   * rather than a sample of what an agent meets. Pass "eval" to look at a run, "all" to see both.
   */
  readonly include?: "live" | "eval" | "all";
  /** Only this run, by the id its harness stamped. */
  readonly runId?: string;
}

export interface Join {
  readonly reviewed: readonly ReviewedRow[];
  readonly unreviewed: readonly LedgerRow[];
  /** Markers pointing at a row this ledger does not hold. Counted, never guessed at. */
  readonly dangling: readonly ReviewMarker[];
  /** Reviewed rows for judgments that never happened, which carry no confidence to calibrate. */
  readonly reviewedErrorRows: readonly ReviewedRow[];
  readonly contradicted: number;
  /** Rows left out because they are the other kind of traffic. */
  readonly otherTraffic: { readonly kind: "live" | "eval"; readonly rows: number };
}

export function isLedgerRow(entry: unknown): entry is LedgerRow {
  if (typeof entry !== "object" || entry === null) return false;
  const row = entry as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.question === "string" && typeof row.confidence === "number";
}

export function isReviewMarker(entry: unknown): entry is ReviewMarker {
  if (typeof entry !== "object" || entry === null) return false;
  const marker = entry as Record<string, unknown>;
  return typeof marker.id === "string" && typeof marker.wrong === "boolean" && typeof marker.by === "string";
}

export function classifyEntries(entries: readonly unknown[]): LedgerEntries {
  const rows: LedgerRow[] = [];
  const markers: ReviewMarker[] = [];
  let unreadable = 0;
  for (const entry of entries) {
    if (isLedgerRow(entry)) rows.push(entry);
    else if (isReviewMarker(entry)) markers.push(entry);
    else unreadable += 1;
  }
  return { rows, markers, unreadable };
}

/** The marker that counts for each row id, and how many rows had more than one. */
export function resolveReviews(markers: readonly ReviewMarker[]): {
  readonly latest: ReadonlyMap<string, ReviewMarker>;
  readonly all: ReadonlyMap<string, readonly ReviewMarker[]>;
  readonly contradicted: number;
} {
  const all = new Map<string, ReviewMarker[]>();
  for (const marker of markers) {
    const list = all.get(marker.id);
    if (list === undefined) all.set(marker.id, [marker]);
    else list.push(marker);
  }

  const latest = new Map<string, ReviewMarker>();
  let contradicted = 0;
  for (const [id, list] of all) {
    // Append order decides a tie, so the file's own order is the last word and two markers written
    // in the same millisecond do not resolve differently on different machines.
    let winner = list[0] as ReviewMarker;
    for (const marker of list.slice(1)) {
      if (Date.parse(marker.ts) >= Date.parse(winner.ts)) winner = marker;
    }
    latest.set(id, winner);
    if (list.some((marker) => marker.wrong !== winner.wrong)) contradicted += 1;
  }
  return { latest, all, contradicted };
}

export function joinReviews(entries: readonly unknown[], options: JoinOptions = {}): Join {
  const { rows, markers } = classifyEntries(entries);
  const { latest, all, contradicted } = resolveReviews(markers);

  const include = options.include ?? "live";
  const matching = rows.filter((row) => {
    if (options.decision !== undefined && row.decision !== options.decision) return false;
    if (options.question !== undefined && row.question !== options.question) return false;
    if (options.runId !== undefined && row.runId !== options.runId) return false;
    return true;
  });
  const isEval = (row: LedgerRow): boolean => row.runKind === "eval";
  const wanted = include === "all" ? matching : matching.filter((row) => (include === "eval" ? isEval(row) : !isEval(row)));
  const otherTraffic = {
    kind: (include === "eval" ? "live" : "eval") as "live" | "eval",
    rows: include === "all" ? 0 : matching.length - wanted.length,
  };

  const reviewed: ReviewedRow[] = [];
  const reviewedErrorRows: ReviewedRow[] = [];
  const unreviewed: LedgerRow[] = [];
  for (const row of wanted) {
    const review = latest.get(row.id);
    if (review === undefined) {
      unreviewed.push(row);
      continue;
    }
    const joined: ReviewedRow = { row, review, all: all.get(row.id) ?? [review] };
    // A row with an error is a judgment that never happened: its confidence is a placeholder, not a
    // judge's answer, so it is reported separately rather than dropped into the bottom bin.
    if (row.error !== undefined) reviewedErrorRows.push(joined);
    else reviewed.push(joined);
  }

  const known = new Set(rows.map((row) => row.id));
  const dangling = markers.filter((marker) => !known.has(marker.id));
  return { reviewed, unreviewed, dangling, reviewedErrorRows, contradicted, otherTraffic };
}

/**
 * The method we were measured against, applied to ourselves: ten bins, pooled error over reviewed
 * decisions only, and the smallest confidence at which the pooled error is at or under the target
 * with enough reviewed decisions behind it to mean anything.
 */
export const BIN_COUNT = 10;
export const MAX_POOLED_ERROR = 0.05;
export const MIN_REVIEWED = 100;

export interface CalibrationBin {
  readonly lo: number;
  readonly hi: number;
  readonly label: string;
  readonly reviewed: number;
  readonly wrong: number;
  /** Null when nobody reviewed anything in this bin. Not zero: zero is a claim. */
  readonly error: number | null;
}

export interface Threshold {
  readonly confidence: number;
  readonly reviewed: number;
  readonly pooledError: number;
}

export interface Calibration {
  readonly reviewed: number;
  readonly wrong: number;
  readonly pooledError: number | null;
  readonly bins: readonly CalibrationBin[];
  /** The smallest confidence worth acting on, or null with a sentence saying why not. */
  readonly threshold: Threshold | null;
  readonly shortfall: string | null;
  readonly minReviewed: number;
  readonly maxPooledError: number;
}

export interface CalibrateOptions {
  readonly minReviewed?: number;
  readonly maxPooledError?: number;
}

export function calibrate(reviewed: readonly ReviewedRow[], options: CalibrateOptions = {}): Calibration {
  const minReviewed = options.minReviewed ?? MIN_REVIEWED;
  const maxPooledError = options.maxPooledError ?? MAX_POOLED_ERROR;

  const bins: CalibrationBin[] = [];
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const lo = index / BIN_COUNT;
    const hi = (index + 1) / BIN_COUNT;
    const inBin = reviewed.filter((entry) => inRange(entry.row.confidence, lo, hi, index === BIN_COUNT - 1));
    const wrong = inBin.filter((entry) => entry.review.wrong).length;
    bins.push({
      lo,
      hi,
      label: `${lo.toFixed(1)} to ${hi.toFixed(1)}`,
      reviewed: inBin.length,
      wrong,
      error: inBin.length === 0 ? null : wrong / inBin.length,
    });
  }

  const wrong = reviewed.filter((entry) => entry.review.wrong).length;
  const pooledError = reviewed.length === 0 ? null : wrong / reviewed.length;

  let threshold: Threshold | null = null;
  let bestPool = 0;
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const at = index / BIN_COUNT;
    const pool = reviewed.filter((entry) => entry.row.confidence >= at);
    bestPool = Math.max(bestPool, pool.length);
    if (pool.length < minReviewed) continue;
    const poolWrong = pool.filter((entry) => entry.review.wrong).length;
    const poolError = poolWrong / pool.length;
    if (poolError <= maxPooledError) {
      threshold = { confidence: at, reviewed: pool.length, pooledError: poolError };
      break;
    }
  }

  return {
    reviewed: reviewed.length,
    wrong,
    pooledError,
    bins,
    threshold,
    shortfall: threshold === null ? shortfallReason(reviewed.length, minReviewed, maxPooledError) : null,
    minReviewed,
    maxPooledError,
  };
}

function inRange(value: number, lo: number, hi: number, last: boolean): boolean {
  return value >= lo && (last ? value <= hi : value < hi);
}

function shortfallReason(reviewed: number, minReviewed: number, maxPooledError: number): string {
  if (reviewed === 0) {
    return "no judgment in this ledger has been reviewed, so there is no denominator and no threshold can be set";
  }
  if (reviewed < minReviewed) {
    return `${reviewed} reviewed ${reviewed === 1 ? "judgment" : "judgments"}, and a threshold needs at least ${minReviewed}`;
  }
  return `at every confidence with ${minReviewed} or more reviewed judgments the pooled error is above ${(maxPooledError * 100).toFixed(0)} percent`;
}

/** Reads a ledger file and calibrates it in one call. */
export async function calibrateLedger(
  path?: string,
  options: JoinOptions & CalibrateOptions = {},
): Promise<{ readonly join: Join; readonly calibration: Calibration }> {
  const entries = await readLedger(path);
  const join = joinReviews(entries, options);
  return { join, calibration: calibrate(join.reviewed, options) };
}

/**
 * The report. It says what it does not know in words, because a bucket of four decisions and a
 * bucket of four hundred print the same percentage and only one of them is an answer.
 */
export function describeCalibration(join: Join, calibration: Calibration, label = "the ledger"): string {
  const lines: string[] = [];
  const total = join.reviewed.length + join.unreviewed.length;
  lines.push(`Calibration of ${label}`);
  lines.push(
    `${total} judgment ${total === 1 ? "row" : "rows"}, ${join.reviewed.length} reviewed, ${join.unreviewed.length} never looked at`,
  );
  if (join.reviewedErrorRows.length > 0) {
    lines.push(`${join.reviewedErrorRows.length} reviewed row(s) are fallbacks with no judge answer, left out of the bins`);
  }
  if (join.otherTraffic.rows > 0) {
    const hint = join.otherTraffic.kind === "eval" ? "pass --include eval to read them" : "these are live decisions";
    lines.push(`${join.otherTraffic.rows} ${join.otherTraffic.kind} row(s) left out: ${hint}`);
  }
  if (join.dangling.length > 0) lines.push(`${join.dangling.length} marker(s) point at a row this ledger does not hold`);
  if (join.contradicted > 0) lines.push(`${join.contradicted} row(s) carry markers that disagree; the most recent one counts`);
  lines.push("");

  lines.push("pooled error by confidence, over reviewed judgments only");
  for (const bin of calibration.bins) {
    const rate = bin.error === null ? "no reviews" : `${(bin.error * 100).toFixed(1)}% wrong`;
    lines.push(`  ${bin.label}   ${rate.padStart(14)}   reviewed ${bin.reviewed}`);
  }
  lines.push("");

  if (calibration.pooledError === null) {
    lines.push("pooled error: nothing to pool");
  } else {
    lines.push(
      `pooled error over all reviewed judgments: ${(calibration.pooledError * 100).toFixed(1)}% (${calibration.wrong} of ${calibration.reviewed})`,
    );
  }

  if (calibration.threshold !== null) {
    const t = calibration.threshold;
    lines.push(
      `smallest confidence worth acting on: ${t.confidence.toFixed(1)}, where ${t.reviewed} reviewed judgments are ${(t.pooledError * 100).toFixed(1)}% wrong`,
    );
  } else {
    lines.push(`no threshold can be set: ${calibration.shortfall}`);
  }
  return lines.join("\n");
}
