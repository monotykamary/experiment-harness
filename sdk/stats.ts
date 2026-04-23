/**
 * Statistical helpers for experiment analysis.
 */

import type { ExperimentResult, MetricDef } from "./types.ts";

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** Check if a metric change is an improvement (in the desired direction). */
export function isImprovement(
  current: number,
  baseline: number,
  direction: "lower" | "higher",
): boolean {
  return direction === "lower" ? current < baseline : current > baseline;
}

/**
 * Format an improvement percentage that's intuitive for both directions.
 * For "lower": a decrease shows as positive improvement (e.g. -18% → "+18.0% faster").
 * For "higher": an increase shows as positive improvement.
 * Returns null if baseline is 0, or if there's no change, or if the change
 * is a regression.
 */
export function formatImprovement(
  current: number,
  baseline: number,
  direction: "lower" | "higher",
): string | null {
  if (baseline === 0) return null;
  if (current === baseline) return null;

  const improved = isImprovement(current, baseline, direction);
  const delta = current - baseline;
  const pct = Math.abs((delta / baseline) * 100).toFixed(1);

  if (improved) {
    return `+${pct}%`;
  } else {
    return `-${pct}%`;
  }
}

/** Compute the median of a numeric array (returns 0 for empty arrays). */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Check if current value is better than best based on direction. */
export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher",
): boolean {
  return direction === "lower" ? current < best : current > best;
}

// ---------------------------------------------------------------------------
// Confidence Scoring
// ---------------------------------------------------------------------------

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values as a robust
 * noise estimator. Returns `|best_delta| / MAD`.
 *
 * Returns null when there are fewer than 3 data points or when MAD is 0.
 */
export function computeConfidence(
  results: ExperimentResult[],
  direction: "lower" | "higher",
): number | null {
  const validResults = results.filter((r) => r.metric > 0);
  if (validResults.length < 3) return null;

  const values = validResults.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = validResults[0]?.metric ?? null;
  if (baseline === null) return null;

  // Find best kept metric
  let bestKept: number | null = null;
  for (const r of validResults) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

// ---------------------------------------------------------------------------
// Plateau Detection
// ---------------------------------------------------------------------------

/**
 * Check whether the session has plateaued — the best metric hasn't improved
 * for `patience` consecutive measured iterations.
 */
export function detectPlateau(
  results: ExperimentResult[],
  direction: "lower" | "higher",
  patience: number = 15,
): { plateaued: boolean; iterationsSinceBest: number } {
  if (results.length < patience) return { plateaued: false, iterationsSinceBest: 0 };

  // Find the best metric and when it was achieved
  let bestMetric: number | null = null;
  let bestIdx = -1;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.metric > 0 && r.status === "keep") {
      if (bestMetric === null || isBetter(r.metric, bestMetric, direction)) {
        bestMetric = r.metric;
        bestIdx = i;
      }
    }
  }

  if (bestMetric === null) return { plateaued: false, iterationsSinceBest: 0 };

  const iterationsSinceBest = results.length - 1 - bestIdx;
  return {
    plateaued: iterationsSinceBest >= patience,
    iterationsSinceBest,
  };
}

// ---------------------------------------------------------------------------
// Secondary Metrics
// ---------------------------------------------------------------------------

/** Register secondary metric names from an experiment result. */
export function registerSecondaryMetrics(
  known: MetricDef[],
  metrics: Record<string, number>,
  inferUnitFn: (name: string) => string,
): MetricDef[] {
  const updated = [...known];
  for (const name of Object.keys(metrics)) {
    if (!updated.find((m) => m.name === name)) {
      updated.push({ name, unit: inferUnitFn(name) });
    }
  }
  return updated;
}

/** Find secondary metric baselines from the first experiment in current segment. */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[],
): Record<string, number> {
  const cur = results.filter((r) => r.segment === segment);
  const base: Record<string, number> = cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};

  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}
