import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Ledger, LedgerRow, WrongMarker } from "./types.ts";

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
    async append(row: LedgerRow | WrongMarker): Promise<void> {
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
  readonly rows: readonly (LedgerRow | WrongMarker)[];
}

/** For tests, and for a caller that wants the rows without a file. */
export function memoryLedger(): MemoryLedger {
  const rows: (LedgerRow | WrongMarker)[] = [];
  return {
    rows,
    async append(row: LedgerRow | WrongMarker): Promise<void> {
      rows.push(row);
    },
  };
}

/** A ledger that records nothing, for a caller that only wants the action. */
export function nullLedger(): Ledger {
  return { async append(): Promise<void> {} };
}

/**
 * A person marking a judgment wrong appends a marker rather than editing the row, so the original
 * judgment and the correction both survive and neither can be quietly turned into the other.
 */
export async function markWrong(
  ledger: Ledger,
  decisionId: string,
  by: string,
  options: { readonly now?: () => Date } = {},
): Promise<WrongMarker> {
  const marker: WrongMarker = {
    id: decisionId,
    wrong: true,
    by,
    ts: (options.now ?? (() => new Date()))().toISOString(),
  };
  await ledger.append(marker);
  return marker;
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
