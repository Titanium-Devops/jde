// What a case set would score if nobody judged it.
//
// A blind set that reports "36 of 40" says nothing until you know what always answering the most
// common label would have scored on the same 40. This module reads the labels out of a case file
// and computes that floor, the way the jevals benchmark defines it: a prior that answers every item
// with the set's own base rates, scored by multiclass Brier, and a Decision Score where 100 is
// perfect, 0 is the prior, and below 0 is worse than not looking.
//
// No I/O and no model. The labels come in, the floor goes out.

export type Counts = Readonly<Record<string, number>>;

export type Distribution = {
  /** How many labelled items the field has. */
  readonly n: number;
  /** Label to how many items carry it. */
  readonly counts: Counts;
  /** Label to its base rate, the prior's answer for every item. */
  readonly shares: Readonly<Record<string, number>>;
};

export type MajorityBaseline = {
  /** The label the baseline always answers. */
  readonly label: string;
  readonly correct: number;
  readonly n: number;
  /** correct / n, the accuracy of answering that label every time. */
  readonly accuracy: number;
};

/** One thing the case author labelled, pooled over every item that carries it. */
export type LabelField = {
  /** `verdict`, `parts[]` for an array of per-part labels, `parts{}` for a map of them. */
  readonly name: string;
  /** What one labelled item is: a case, or a part of one. */
  readonly unit: "case" | "part";
  /** Which block of the case it was read from. */
  readonly block: string;
  /** How many cases carry the field at all. */
  readonly presentIn: number;
  /** The keys pooled into this field, when it was assembled from several. */
  readonly pooledFrom?: readonly string[];
  readonly distribution: Distribution;
};

export type SkippedField = {
  readonly name: string;
  readonly block: string;
  readonly reason: string;
};

export type Labelling = {
  readonly cases: number;
  readonly fields: readonly LabelField[];
  readonly skipped: readonly SkippedField[];
};

type Scalar = string | number | boolean | null;

const isScalar = (v: unknown): v is Scalar =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** A label is the value written down, as text. `null` is a label like any other. */
export const labelOf = (v: Scalar): string => (v === null ? "null" : String(v));

export function distributionOf(labels: readonly string[]): Distribution {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  const n = labels.length;
  const shares: Record<string, number> = {};
  for (const [label, count] of Object.entries(counts)) shares[label] = n === 0 ? 0 : count / n;
  return { n, counts, shares };
}

/** Always answer the most common label. Ties go to the label that sorts first, so it is repeatable. */
export function majorityBaseline(d: Distribution): MajorityBaseline {
  const entries = Object.entries(d.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries[0];
  if (!top || d.n === 0) return { label: "", correct: 0, n: 0, accuracy: 0 };
  return { label: top[0], correct: top[1], n: d.n, accuracy: top[1] / d.n };
}

/**
 * Mean per-item multiclass Brier score of the base-rate prior: for each item, sum over every label k
 * of (p_k - y_k)^2, where p is the field's base rates and y is one at the true label and zero
 * elsewhere. Averaged over the items. Zero is a set with one label in it; the more evenly the labels
 * are spread, the higher it climbs.
 *
 * Written as the definition reads rather than as the identity it collapses to, so that a mistake in
 * the definition shows up as a wrong number instead of hiding in algebra.
 */
export function priorBrierLoss(d: Distribution): number {
  if (d.n === 0) return 0;
  const labels = Object.keys(d.counts);
  let total = 0;
  for (const trueLabel of labels) {
    let perItem = 0;
    for (const k of labels) {
      const p = d.shares[k] ?? 0;
      const y = k === trueLabel ? 1 : 0;
      perItem += (p - y) ** 2;
    }
    // Every item carrying this label scores the same, so weight instead of looping over items.
    total += perItem * (d.counts[trueLabel] ?? 0);
  }
  return total / d.n;
}

/**
 * The jevals framing: 100 is a perfect answer, 0 is the prior, negative is worse than the prior.
 * Returns null when the prior is already perfect, because then there is nothing to be better than.
 */
export function decisionScore(modelLoss: number, priorLoss: number): number | null {
  if (priorLoss <= 0) return null;
  return 100 * (1 - modelLoss / priorLoss);
}

/**
 * The same framing in accuracy space, for a recorded score that is a count of right answers rather
 * than a set of probabilities: how much of the room above the majority baseline the run took.
 */
export function accuracyDecisionScore(accuracy: number, baseline: number): number | null {
  if (baseline >= 1) return null;
  return 100 * ((accuracy - baseline) / (1 - baseline));
}

const TEMPLATE = /\d+/g;

/**
 * Read the label fields out of a list of cases. Shapes are worked out per file rather than assumed:
 * a scalar under `expected` is one label per case, an array or a map of scalars is one label per
 * part, and keys that differ only by an index (`part_0_done`, `part_1_done`) are the same question
 * asked repeatedly and pool into one field. Anything else is skipped by name, with the reason.
 */
export function labelFields(cases: readonly unknown[], blocks: readonly string[] = ["expected", "code_expectations"]): Labelling {
  const fields: LabelField[] = [];
  const skipped: SkippedField[] = [];

  for (const block of blocks) {
    const seen = new Map<string, unknown[]>();
    for (const c of cases) {
      const body = (c as Record<string, unknown> | null)?.[block];
      if (!body || typeof body !== "object" || Array.isArray(body)) continue;
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        const bucket = seen.get(key) ?? [];
        bucket.push(value);
        seen.set(key, bucket);
      }
    }

    const scalarKeys: string[] = [];
    for (const [key, values] of seen) {
      const read = readField(key, block, values);
      if (read.kind === "skip") skipped.push({ name: key, block, reason: read.reason });
      else if (read.kind === "part") fields.push(read.field);
      else scalarKeys.push(key);
    }

    // One question asked once per part, written as several keys. Pool it, and say which keys.
    const byTemplate = new Map<string, string[]>();
    for (const key of scalarKeys) {
      const template = key.replace(TEMPLATE, "*");
      byTemplate.set(template, [...(byTemplate.get(template) ?? []), key]);
    }
    for (const [template, keys] of byTemplate) {
      const labels: string[] = [];
      let presentIn = 0;
      for (const key of keys) {
        for (const v of seen.get(key) ?? []) {
          if (!isScalar(v)) continue;
          labels.push(labelOf(v));
          presentIn++;
        }
      }
      const pooled = keys.length > 1;
      fields.push({
        name: pooled ? template : (keys[0] as string),
        unit: pooled ? "part" : "case",
        block,
        presentIn: pooled ? presentIn : labels.length,
        ...(pooled ? { pooledFrom: [...keys].sort() } : {}),
        distribution: distributionOf(labels),
      });
    }
  }

  return { cases: cases.length, fields, skipped };
}

type Read =
  | { kind: "scalar" }
  | { kind: "part"; field: LabelField }
  | { kind: "skip"; reason: string };

function readField(key: string, block: string, values: readonly unknown[]): Read {
  const shapes = new Set(values.map(shapeOf));
  if (shapes.size > 1) return { kind: "skip", reason: `mixed shapes across cases: ${[...shapes].join(", ")}` };
  const shape = [...shapes][0];
  if (shape === "scalar") return { kind: "scalar" };

  const labels: string[] = [];
  for (const v of values) {
    const items = shape === "array" ? (v as unknown[]) : Object.values(v as Record<string, unknown>);
    for (const item of items) {
      if (typeof item === "number") return { kind: "skip", reason: `${shape} of numbers, which are indices or scores rather than labels` };
      if (!isScalar(item)) return { kind: "skip", reason: `${shape} of ${typeof item}, not a label` };
      labels.push(labelOf(item));
    }
  }
  return {
    kind: "part",
    field: {
      name: `${key}${shape === "array" ? "[]" : "{}"}`,
      unit: "part",
      block,
      presentIn: values.length,
      distribution: distributionOf(labels),
    },
  };
}

function shapeOf(v: unknown): string {
  if (isScalar(v)) return "scalar";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "map";
  return typeof v;
}
