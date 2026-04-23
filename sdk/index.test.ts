/**
 * Tests for experiment-harness core modules.
 */

import { describe, it, expect } from "bun:test";
import { parseMetricLines, isAutoresearchShCommand, inferUnit } from "./parse.ts";
import { formatNum, formatElapsed, commas } from "./format.ts";
import {
  sortedMedian,
  isBetter,
  computeConfidence,
  detectPlateau,
  registerSecondaryMetrics,
} from "./stats.ts";
import { reconstructState, writeConfig, writeResult, readEntries } from "./log.ts";
import { createStrategy, GreedyStrategy, ConfidenceGatedStrategy } from "./strategy.ts";
import type {
  ExperimentResult,
  JsonlConfigEntry,
  JsonlResultEntry,
  SessionState,
} from "./types.ts";

// ---------------------------------------------------------------------------
// parse.ts
// ---------------------------------------------------------------------------

describe("parseMetricLines", () => {
  it("parses single METRIC line", () => {
    const output = "some noise\nMETRIC total_µs=12300\nmore noise";
    const metrics = parseMetricLines(output);
    expect(metrics.get("total_µs")).toBe(12300);
  });

  it("parses multiple METRIC lines", () => {
    const output = "METRIC total_µs=12300\nMETRIC compile_µs=4200";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(2);
    expect(metrics.get("total_µs")).toBe(12300);
    expect(metrics.get("compile_µs")).toBe(4200);
  });

  it("ignores denied metric names", () => {
    const output = "METRIC __proto__=1\nMETRIC constructor=2\nMETRIC valid=3";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(1);
    expect(metrics.get("valid")).toBe(3);
  });

  it("ignores non-numeric values", () => {
    const output = "METRIC name=abc";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(0);
  });

  it("returns empty map for no METRIC lines", () => {
    expect(parseMetricLines("no metrics here").size).toBe(0);
  });
});

describe("isAutoresearchShCommand", () => {
  it("accepts bare autoresearch.sh", () => {
    expect(isAutoresearchShCommand("./autoresearch.sh")).toBe(true);
    expect(isAutoresearchShCommand("bash autoresearch.sh")).toBe(true);
  });

  it("accepts with env var prefix", () => {
    expect(isAutoresearchShCommand("FOO=bar ./autoresearch.sh")).toBe(true);
  });

  it("accepts with time/nice wrapper", () => {
    expect(isAutoresearchShCommand("time ./autoresearch.sh")).toBe(true);
    expect(isAutoresearchShCommand("nice -n 19 ./autoresearch.sh")).toBe(true);
  });

  it("rejects chained commands", () => {
    expect(isAutoresearchShCommand("evil.py; ./autoresearch.sh")).toBe(false);
  });

  it("rejects custom commands", () => {
    expect(isAutoresearchShCommand("pnpm test")).toBe(false);
  });
});

describe("inferUnit", () => {
  it("infers µs", () => expect(inferUnit("total_µs")).toBe("µs"));
  it("infers ms", () => expect(inferUnit("wall_ms")).toBe("ms"));
  it("infers s", () => expect(inferUnit("wall_s")).toBe("s"));
  it("infers kb", () => expect(inferUnit("bundle_kb")).toBe("kb"));
  it("infers mb", () => expect(inferUnit("bundle_mb")).toBe("mb"));
  it("returns empty for unknown", () => expect(inferUnit("score")).toBe(""));
});

// ---------------------------------------------------------------------------
// format.ts
// ---------------------------------------------------------------------------

describe("formatNum", () => {
  it("formats integers with commas", () => {
    expect(formatNum(15586, "")).toBe("15,586");
  });

  it("formats with unit", () => {
    expect(formatNum(12, "s")).toBe("12s");
  });

  it("formats null as em dash", () => {
    expect(formatNum(null, "")).toBe("—");
  });

  it("formats fractional values", () => {
    expect(formatNum(12.3, "s")).toBe("12.30s");
  });
});

describe("formatElapsed", () => {
  it("formats seconds", () => {
    expect(formatElapsed(5000)).toBe("5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(125000)).toBe("2m 05s");
  });
});

// ---------------------------------------------------------------------------
// stats.ts
// ---------------------------------------------------------------------------

describe("sortedMedian", () => {
  it("returns 0 for empty array", () => {
    expect(sortedMedian([])).toBe(0);
  });

  it("returns the element for odd-length array", () => {
    expect(sortedMedian([1, 3, 5])).toBe(3);
  });

  it("returns average of two middle elements for even-length array", () => {
    expect(sortedMedian([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("isBetter", () => {
  it("lower is better", () => {
    expect(isBetter(5, 10, "lower")).toBe(true);
    expect(isBetter(15, 10, "lower")).toBe(false);
  });

  it("higher is better", () => {
    expect(isBetter(15, 10, "higher")).toBe(true);
    expect(isBetter(5, 10, "higher")).toBe(false);
  });
});

describe("computeConfidence", () => {
  it("returns null for fewer than 3 results", () => {
    const results = makeResults([10, 8]);
    expect(computeConfidence(results, "lower")).toBe(null);
  });

  it("returns null for zero MAD", () => {
    const results = makeResults([10, 10, 10]);
    expect(computeConfidence(results, "lower")).toBe(null);
  });

  it("computes confidence for improving results", () => {
    const results = makeResults([100, 90, 80, 70]);
    const conf = computeConfidence(results, "lower");
    expect(conf).not.toBe(null);
    expect(conf!).toBeGreaterThan(0);
  });
});

describe("detectPlateau", () => {
  it("detects plateau", () => {
    // 15 results, all with same best metric
    const results = makeResults([
      100, 90, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80,
    ].map((v, i) => v === 80 && i > 2 ? 80 + (i % 3) : v)); // slight noise
    // Make the first 3 "keep", rest "discard"
    results[0].status = "keep";
    results[1].status = "keep";
    results[2].status = "keep";
    for (let i = 3; i < results.length; i++) {
      results[i].status = "discard";
    }
    const plateau = detectPlateau(results, "lower", 10);
    expect(plateau.iterationsSinceBest).toBeGreaterThan(0);
  });

  it("no plateau with improving results", () => {
    const results = makeResults([100, 90, 80, 70, 60]);
    const plateau = detectPlateau(results, "lower", 15);
    expect(plateau.plateaued).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// log.ts
// ---------------------------------------------------------------------------

describe("reconstructState", () => {
  it("returns initial state for empty entries", () => {
    const state = reconstructState([]);
    expect(state.config).toBe(null);
    expect(state.results.length).toBe(0);
  });

  it("reconstructs state from config + result entries", () => {
    const entries = [
      {
        type: "config" as const,
        name: "test",
        metricName: "seconds",
        metricUnit: "s",
        direction: "lower" as const,
        targetValue: null,
        segment: 0,
        command: "bash test.sh",
      },
      {
        type: "result" as const,
        run: 1,
        commit: "abc1234",
        metric: 12.5,
        metrics: {},
        status: "keep" as const,
        description: "baseline",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
        durationSeconds: 12.5,
      },
    ];

    const state = reconstructState(entries);
    expect(state.config?.name).toBe("test");
    expect(state.results.length).toBe(1);
    expect(state.baselineMetric).toBe(12.5);
    expect(state.bestMetric).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// strategy.ts
// ---------------------------------------------------------------------------

describe("GreedyStrategy", () => {
  const strategy = new GreedyStrategy();

  it("keeps improvements", () => {
    const result = makeResult(8, "keep");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("discards regressions", () => {
    const result = makeResult(12, "keep");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });

  it("keeps first result (baseline)", () => {
    const result = makeResult(10, "keep");
    const state = makeState(null, "lower");
    expect(strategy.evaluate(result, state)).toBe("keep");
  });
});

describe("ConfidenceGatedStrategy", () => {
  it("discards regressions", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(12, "keep");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });
});

describe("createStrategy", () => {
  it("creates greedy by default", () => {
    expect(createStrategy()).toBeInstanceOf(GreedyStrategy);
  });

  it("creates by name", () => {
    expect(createStrategy("confidence-gated")).toBeInstanceOf(ConfidenceGatedStrategy);
  });

  it("creates with config", () => {
    const s = createStrategy({ name: "confidence-gated", minConfidence: 2.0 });
    expect(s).toBeInstanceOf(ConfidenceGatedStrategy);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(metric: number, status: "keep" | "discard" | "crash"): ExperimentResult {
  return {
    run: 1,
    commit: "abc1234",
    metric,
    metrics: {},
    status,
    description: "test",
    timestamp: Date.now(),
    segment: 0,
    confidence: null,
    durationSeconds: 1,
  };
}

function makeState(baseline: number | null, direction: "lower" | "higher"): SessionState {
  return {
    config: { name: "test", metricName: "seconds", direction, command: "echo" },
    results: baseline !== null ? [makeResult(baseline, "keep")] : [],
    baselineMetric: baseline,
    bestMetric: baseline,
    direction,
    metricName: "seconds",
    metricUnit: "s",
    secondaryMetrics: [],
    currentSegment: 0,
    confidence: null,
    targetValue: null,
    maxRuns: null,
    guard: null,
  };
}

function makeResults(metrics: number[]): ExperimentResult[] {
  return metrics.map((m, i) => ({
    run: i + 1,
    commit: `c${i}`,
    metric: m,
    metrics: {},
    status: (i === 0 || m < metrics[0]) ? "keep" as const : "discard" as const,
    description: `run ${i + 1}`,
    timestamp: Date.now() + i * 1000,
    segment: 0,
    confidence: null,
    durationSeconds: m / 10,
  }));
}
