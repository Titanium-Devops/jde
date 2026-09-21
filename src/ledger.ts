import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Ledger, LedgerRow, ReviewMarker, RunKind, WrongMarker } from "./types.ts";

/**
 * One line per judgment, appended, never rewritten.
 *
 * What is not written is the state: no request text, no evidence, no page content, no claimed
 * result. A ledger that quietly accumulated the material it judged would be a second copy of the
 * data this engine exists to be careful with. What a reader needs is the decision, its confidence,
 * the band it landed in and what code did about it, which is all a row carries.
 *
 * Appending is best effort in every sense. A ledger that threw would take down the turn it was
 * meant to record, which is the opposite of the point.
 */

export function defaultLedgerPath(): string {
  return process.env.JDE_LEDGER_PATH ?? ".jde/ledger.jsonl";
}

export function fileLedger(path: string = defaultLedgerPath()): Ledger {
  return {
    async append(row: LedgerRow | ReviewMarker): Promise<void> {
      try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600);
      } catch {
        // A ledger write is never the reason a decision fails.
      }
    },
  };
}

export interface MemoryLedger extends Ledger {
  readonly rows: readonly (LedgerRow | ReviewMarker)[];
}

/** For tests, and for a caller that wants the rows without a file. */
export function memoryLedger(): MemoryLedger {
  const rows: (LedgerRow | ReviewMarker)[] = [];
  return {
    rows,
    async append(row: LedgerRow | ReviewMarker): Promise<void> {
      rows.push(row);
    },
  };
}

/** A ledger that records nothing, for a caller that only wants the action. */
export function nullLedger(): Ledger {
  return { async append(): Promise<void> {} };
}

/**
 * A sink that stamps every judgment it is handed as belonging to one run.
 *
 * The tag comes from the sink rather than from each call on purpose. A harness that has to
 * remember a field on every ask() is a harness that will one day forget it on one, and an untagged
 * eval row is indistinguishable from a live one forever after. Wrap the file once and it cannot be
 * forgotten. Review markers pass through untouched: a verdict belongs to the person who wrote it,
 * not to the run that produced the row.
 */
export function taggedLedger(inner: Ledger, tag: { readonly runKind: RunKind; readonly runId: string }): Ledger {
  return {
    async append(row: LedgerRow | ReviewMarker): Promise<void> {
      if (!("question" in row)) return inner.append(row);
      return inner.append({ ...row, runKind: tag.runKind, runId: tag.runId });
    },
  };
}

export interface ReviewOptions {
  /** One line on why, for the person reading the row later. */
  readonly why?: string;
  readonly now?: () => Date;
}

/**
 * A reviewer's verdict on one judgment, appended rather than written over the row, so the judgment
 * and the verdict on it both survive and neither can be quietly turned into the other.
 *
 * Both halves are recorded. A judgment nobody reviewed and a judgment reviewed and found right are
 * different facts, and a ledger that only records the wrong ones can count mistakes but can never
 * divide by anything: see `calibrate` in review.ts for what that costs.
 */
export async function markReviewed(
  ledger: Ledger,
  decisionId: string,
  verdict: { readonly wrong: boolean; readonly by: string },
  options: ReviewOptions = {},
): Promise<ReviewMarker> {
  const marker: ReviewMarker = {
    id: decisionId,
    wrong: verdict.wrong,
    by: verdict.by,
    ts: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.why === undefined ? {} : { why: options.why }),
  };
  await ledger.append(marker);
  return marker;
}

/** The judgment was wrong. Unchanged: the same call, the same row shape it has always written. */
export async function markWrong(
  ledger: Ledger,
  decisionId: string,
  by: string,
  options: ReviewOptions = {},
): Promise<WrongMarker> {
  return (await markReviewed(ledger, decisionId, { wrong: true, by }, options)) as WrongMarker;
}

/** The judgment was looked at and it was right. The other half of the denominator. */
export async function markRight(
  ledger: Ledger,
  decisionId: string,
  by: string,
  options: ReviewOptions = {},
): Promise<ReviewMarker> {
  return markReviewed(ledger, decisionId, { wrong: false, by }, options);
}

export async function readLedger(path: string = defaultLedgerPath()): Promise<readonly unknown[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((row): row is unknown => row !== undefined);
  } catch {
    return [];
  }
}
