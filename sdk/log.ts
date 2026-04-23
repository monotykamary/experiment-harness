/**
 * JSONL log — append-only source of truth for experiment sessions.
 *
 * Each line is a JSON object. Config headers and result entries are interleaved.
 * The log is the sole source of truth — all state is reconstructed from it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  JsonlEntry,
  JsonlConfigEntry,
  JsonlResultEntry,
  ExperimentResult,
  SessionState,
  SessionConfig,
  MetricDef,
} from "./types.ts";
import { inferUnit } from "./parse.ts";
import { computeConfidence, registerSecondaryMetrics } from "./stats.ts";

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write a config header to the JSONL log. Creates the file if it doesn't exist. */
export function writeConfig(
  jsonlPath: string,
  config: JsonlConfigEntry,
): void {
  const line = JSON.stringify(config) + "\n";
  if (fs.existsSync(jsonlPath)) {
    fs.appendFileSync(jsonlPath, line, "utf-8");
  } else {
    // Ensure parent directory exists
    const dir = path.dirname(jsonlPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(jsonlPath, line, "utf-8");
  }
}

/** Append an experiment result to the JSONL log. */
export function writeResult(
  jsonlPath: string,
  result: JsonlResultEntry,
): void {
  const dir = path.dirname(jsonlPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(jsonlPath, JSON.stringify(result) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read all entries from a JSONL log. Skips malformed lines. */
export function readEntries(jsonlPath: string): JsonlEntry[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "config" || entry.type === "result") {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// State Reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct session state from JSONL entries.
 * This is the ONLY way state should be rebuilt — the JSONL is the source of truth.
 */
export function reconstructState(entries: JsonlEntry[]): SessionState {
  const state: SessionState = {
    config: null,
    results: [],
    baselineMetric: null,
    bestMetric: null,
    direction: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    currentSegment: 0,
    confidence: null,
    targetValue: null,
    maxRuns: null,
    guard: null,
  };

  let lastConfig: SessionConfig | null = null;

  for (const entry of entries) {
    if (entry.type === "config") {
      const c = entry as JsonlConfigEntry;
      lastConfig = {
        name: c.name,
        metricName: c.metricName,
        metricUnit: c.metricUnit,
        direction: c.direction,
        command: c.command,
        targetValue: c.targetValue ?? undefined,
      };
      state.config = lastConfig;
      state.metricName = c.metricName;
      state.metricUnit = c.metricUnit;
      state.direction = c.direction;
      state.targetValue = c.targetValue;
      state.currentSegment = c.segment;

      // Reset per-segment state
      state.baselineMetric = null;
      state.bestMetric = null;
      state.secondaryMetrics = [];
      state.confidence = null;
    }

    if (entry.type === "result") {
      const e = entry as JsonlResultEntry;
      const experiment: ExperimentResult = {
        run: e.run,
        commit: e.commit,
        metric: e.metric,
        metrics: e.metrics ?? {},
        status: e.status,
        description: e.description ?? "",
        timestamp: e.timestamp ?? Date.now(),
        segment: e.segment ?? 0,
        confidence: e.confidence ?? null,
        durationSeconds: e.durationSeconds ?? 0,
        asi: e.asi,
      };
      state.results.push(experiment);

      // Register secondary metrics
      if (experiment.metrics) {
        state.secondaryMetrics = registerSecondaryMetrics(
          state.secondaryMetrics,
          experiment.metrics,
          inferUnit,
        );
      }
    }
  }

  // Recalculate derived state
  if (state.results.length > 0) {
    // Baseline = first result in current segment
    const currentSegmentResults = state.results.filter(
      (r) => r.segment === state.currentSegment,
    );
    state.baselineMetric = currentSegmentResults[0]?.metric ?? null;

    // Best kept metric
    let best: number | null = null;
    for (const r of currentSegmentResults) {
      if (r.status === "keep" && r.metric > 0) {
        if (best === null || (state.direction === "lower" ? r.metric < best : r.metric > best)) {
          best = r.metric;
        }
      }
    }
    state.bestMetric = best ?? state.baselineMetric;

    // Confidence
    state.confidence = computeConfidence(state.results, state.direction);
  }

  return state;
}

/**
 * Delete the JSONL log file.
 */
export function deleteLog(jsonlPath: string): boolean {
  if (fs.existsSync(jsonlPath)) {
    fs.unlinkSync(jsonlPath);
    return true;
  }
  return false;
}
