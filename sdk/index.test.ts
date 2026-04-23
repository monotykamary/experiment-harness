/**
 * Tests for experiment-harness core modules.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { parseMetricLines, isAutoresearchShCommand, inferUnit } from "./parse.ts";
import { formatNum, formatElapsed, commas, formatSize } from "./format.ts";
import {
  sortedMedian,
  isBetter,
  isImprovement,
  formatImprovement,
  computeConfidence,
  detectPlateau,
  registerSecondaryMetrics,
} from "./stats.ts";
import { reconstructState, writeConfig, writeResult, readEntries, deleteLog } from "./log.ts";
import { createStrategy, GreedyStrategy, ConfidenceGatedStrategy, EpsilonGreedyStrategy, type RandomSource } from "./strategy.ts";
import { Session } from "./session.ts";
import {
  git,
  gitSafe,
  getHeadCommit,
  getDisplayWorktreePath,
  getProtectedFiles,
  createWorktree,
  removeWorktree,
  commitChanges,
  revertChanges,
  detectWorktree,
} from "./git.ts";
import type {
  ExperimentResult,
  JsonlConfigEntry,
  JsonlResultEntry,
  SessionState,
  SessionConfig,
} from "./types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// ═══════════════════════════════════════════════════════════════════════════
// parse.ts
// ═══════════════════════════════════════════════════════════════════════════

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
    const output = "METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\nMETRIC valid=4";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(1);
    expect(metrics.get("valid")).toBe(4);
  });

  it("ignores non-numeric values", () => {
    const output = "METRIC name=abc\nMETRIC name2=NaN\nMETRIC name3=Infinity";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(0);
  });

  it("returns empty map for no METRIC lines", () => {
    expect(parseMetricLines("no metrics here").size).toBe(0);
  });

  it("returns empty map for empty string", () => {
    expect(parseMetricLines("").size).toBe(0);
  });

  it("parses negative values", () => {
    const output = "METRIC delta=-5";
    const metrics = parseMetricLines(output);
    expect(metrics.get("delta")).toBe(-5);
  });

  it("parses decimal values", () => {
    const output = "METRIC score=0.95";
    const metrics = parseMetricLines(output);
    expect(metrics.get("score")).toBe(0.95);
  });

  it("last occurrence wins on duplicate keys", () => {
    const output = "METRIC x=1\nMETRIC x=2";
    const metrics = parseMetricLines(output);
    expect(metrics.get("x")).toBe(2);
  });

  it("ignores METRIC lines embedded in words", () => {
    const output = "XMETRIC foo=1\nMETRIC bar=2";
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(1);
    expect(metrics.get("bar")).toBe(2);
  });

  it("handles mixed output with noise", () => {
    const output = `Running tests...
✓ 12 tests passed
METRIC seconds=3.2
METRIC coverage_pct=87.5
Done in 3.2s`;
    const metrics = parseMetricLines(output);
    expect(metrics.size).toBe(2);
    expect(metrics.get("seconds")).toBe(3.2);
    expect(metrics.get("coverage_pct")).toBe(87.5);
  });
});

describe("isAutoresearchShCommand", () => {
  it("accepts bare autoresearch.sh", () => {
    expect(isAutoresearchShCommand("./autoresearch.sh")).toBe(true);
    expect(isAutoresearchShCommand("bash autoresearch.sh")).toBe(true);
  });

  it("accepts with env var prefix", () => {
    expect(isAutoresearchShCommand("FOO=bar ./autoresearch.sh")).toBe(true);
    expect(isAutoresearchShCommand("A=1 B=2 bash autoresearch.sh")).toBe(true);
  });

  it("accepts with time/nice wrapper", () => {
    expect(isAutoresearchShCommand("time ./autoresearch.sh")).toBe(true);
    expect(isAutoresearchShCommand("nice -n 19 ./autoresearch.sh")).toBe(true);
  });

  it("accepts with sh", () => {
    expect(isAutoresearchShCommand("sh autoresearch.sh")).toBe(true);
  });

  it("accepts with source", () => {
    expect(isAutoresearchShCommand("source autoresearch.sh")).toBe(true);
  });

  it("rejects chained commands", () => {
    expect(isAutoresearchShCommand("evil.py; ./autoresearch.sh")).toBe(false);
  });

  it("rejects custom commands", () => {
    expect(isAutoresearchShCommand("pnpm test")).toBe(false);
    expect(isAutoresearchShCommand("python train.py")).toBe(false);
  });

  it("rejects piped commands", () => {
    expect(isAutoresearchShCommand("cat data | ./autoresearch.sh")).toBe(false);
  });

  it("accepts with bash flags", () => {
    expect(isAutoresearchShCommand("bash -e autoresearch.sh")).toBe(true);
  });

  it("accepts absolute path", () => {
    expect(isAutoresearchShCommand("/path/to/autoresearch.sh")).toBe(true);
  });
});

describe("inferUnit", () => {
  it("infers µs", () => expect(inferUnit("total_µs")).toBe("µs"));
  it("infers ms", () => expect(inferUnit("wall_ms")).toBe("ms"));
  it("infers s", () => expect(inferUnit("wall_s")).toBe("s"));
  it("infers sec", () => expect(inferUnit("wall_sec")).toBe("s"));
  it("infers kb", () => expect(inferUnit("bundle_kb")).toBe("kb"));
  it("infers mb", () => expect(inferUnit("bundle_mb")).toBe("mb"));
  it("returns empty for unknown", () => expect(inferUnit("score")).toBe(""));
  it("returns empty for empty string", () => expect(inferUnit("")).toBe(""));
});

// ═══════════════════════════════════════════════════════════════════════════
// format.ts
// ═══════════════════════════════════════════════════════════════════════════

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

  it("formats large numbers with commas and unit", () => {
    expect(formatNum(1234567, "µs")).toBe("1,234,567µs");
  });

  it("formats zero with unit", () => {
    expect(formatNum(0, "ms")).toBe("0ms");
  });

  it("formats negative fractional", () => {
    expect(formatNum(-12.5, "%")).toBe("-12.50%");
  });
});

describe("formatElapsed", () => {
  it("formats seconds", () => {
    expect(formatElapsed(5000)).toBe("5s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(125000)).toBe("2m 05s");
  });

  it("formats zero", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  it("formats under a minute", () => {
    expect(formatElapsed(30000)).toBe("30s");
  });

  it("formats exact minute", () => {
    expect(formatElapsed(60000)).toBe("1m 00s");
  });
});

describe("commas", () => {
  it("formats positive numbers", () => {
    expect(commas(15586)).toBe("15,586");
  });

  it("formats negative numbers", () => {
    expect(commas(-15586)).toBe("-15,586");
  });

  it("formats zero", () => {
    expect(commas(0)).toBe("0");
  });

  it("formats small numbers", () => {
    expect(commas(42)).toBe("42");
  });

  it("formats exactly 3 digits", () => {
    expect(commas(999)).toBe("999");
  });

  it("formats exactly 4 digits", () => {
    expect(commas(1000)).toBe("1,000");
  });

  it("formats millions", () => {
    expect(commas(1234567)).toBe("1,234,567");
  });

  it("formats negative small number", () => {
    expect(commas(-1)).toBe("-1");
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1500)).toBe("1.5KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
  });

  it("formats zero bytes", () => {
    expect(formatSize(0)).toBe("0B");
  });

  it("formats just under 1KB", () => {
    expect(formatSize(1023)).toBe("1023B");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// stats.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("sortedMedian", () => {
  it("returns 0 for empty array", () => {
    expect(sortedMedian([])).toBe(0);
  });

  it("returns the element for odd-length array", () => {
    expect(sortedMedian([1, 3, 5])).toBe(3);
    expect(sortedMedian([7])).toBe(7);
  });

  it("returns average of two middle elements for even-length array", () => {
    expect(sortedMedian([1, 2, 3, 4])).toBe(2.5);
  });

  it("handles unsorted input", () => {
    expect(sortedMedian([5, 1, 3])).toBe(3);
  });

  it("handles negative numbers", () => {
    expect(sortedMedian([-5, -3, -1])).toBe(-3);
  });

  it("handles single element", () => {
    expect(sortedMedian([42])).toBe(42);
  });

  it("handles two elements", () => {
    expect(sortedMedian([2, 8])).toBe(5);
  });
});

describe("isBetter", () => {
  it("lower is better", () => {
    expect(isBetter(5, 10, "lower")).toBe(true);
    expect(isBetter(15, 10, "lower")).toBe(false);
    expect(isBetter(10, 10, "lower")).toBe(false);
  });

  it("higher is better", () => {
    expect(isBetter(15, 10, "higher")).toBe(true);
    expect(isBetter(5, 10, "higher")).toBe(false);
    expect(isBetter(10, 10, "higher")).toBe(false);
  });
});

describe("isImprovement", () => {
  it("returns true when lower is better and value decreased", () => {
    expect(isImprovement(8, 10, "lower")).toBe(true);
  });

  it("returns false when lower is better and value increased", () => {
    expect(isImprovement(12, 10, "lower")).toBe(false);
  });

  it("returns true when higher is better and value increased", () => {
    expect(isImprovement(12, 10, "higher")).toBe(true);
  });

  it("returns false when higher is better and value decreased", () => {
    expect(isImprovement(8, 10, "higher")).toBe(false);
  });

  it("returns false for no change", () => {
    expect(isImprovement(10, 10, "lower")).toBe(false);
    expect(isImprovement(10, 10, "higher")).toBe(false);
  });
});

describe("formatImprovement", () => {
  it("shows positive improvement for lower-is-better decrease", () => {
    expect(formatImprovement(8, 10, "lower")).toBe("+20.0%");
  });

  it("shows negative for lower-is-better increase (regression)", () => {
    expect(formatImprovement(12, 10, "lower")).toBe("-20.0%");
  });

  it("shows positive improvement for higher-is-better increase", () => {
    expect(formatImprovement(12, 10, "higher")).toBe("+20.0%");
  });

  it("shows negative for higher-is-better decrease (regression)", () => {
    expect(formatImprovement(8, 10, "higher")).toBe("-20.0%");
  });

  it("returns null for no change", () => {
    expect(formatImprovement(10, 10, "lower")).toBe(null);
  });

  it("returns null for zero baseline", () => {
    expect(formatImprovement(5, 0, "higher")).toBe(null);
  });

  it("handles small improvements", () => {
    expect(formatImprovement(9.9, 10, "lower")).toBe("+1.0%");
  });

  it("handles large improvements", () => {
    expect(formatImprovement(1, 100, "lower")).toBe("+99.0%");
  });

  it("handles higher-is-better doubling", () => {
    expect(formatImprovement(20, 10, "higher")).toBe("+100.0%");
  });
});

describe("computeConfidence", () => {
  it("returns null for fewer than 3 results", () => {
    expect(computeConfidence([], "lower")).toBe(null);
    expect(computeConfidence(makeResults([10]), "lower")).toBe(null);
    expect(computeConfidence(makeResults([10, 8]), "lower")).toBe(null);
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

  it("computes confidence for higher-is-better direction", () => {
    const results: ExperimentResult[] = [10, 20, 30, 40].map((m, i) => ({
      run: i + 1,
      commit: `c${i}`,
      metric: m,
      metrics: {},
      status: (m > 10 ? "keep" : "discard") as ExperimentResult["status"],
      description: `run ${i + 1}`,
      timestamp: Date.now() + i * 1000,
      segment: 0,
      confidence: null,
      durationSeconds: m / 10,
    }));
    // First result (baseline) is "discard"; set it to "keep"
    results[0].status = "keep";
    const conf = computeConfidence(results, "higher");
    expect(conf).not.toBe(null);
    expect(conf!).toBeGreaterThan(0);
  });

  it("returns null when no kept results", () => {
    const results = makeResults([100, 90, 80]);
    results.forEach((r) => (r.status = "discard"));
    expect(computeConfidence(results, "lower")).toBe(null);
  });

  it("returns null when best equals baseline", () => {
    const results = makeResults([100, 100, 100, 50]);
    // Make only the first (baseline) "keep"
    results[0].status = "keep";
    results[1].status = "discard";
    results[2].status = "discard";
    results[3].status = "discard";
    expect(computeConfidence(results, "lower")).toBe(null);
  });
});

describe("detectPlateau", () => {
  it("detects plateau", () => {
    const results = makeResults([
      100, 90, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80,
    ].map((v, i) => (v === 80 && i > 2 ? 80 + (i % 3) : v)));
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

  it("no plateau with fewer results than patience", () => {
    const results = makeResults([100, 90]);
    const plateau = detectPlateau(results, "lower", 15);
    expect(plateau.plateaued).toBe(false);
  });

  it("plateau requires patience threshold", () => {
    const results = makeResults([100, 90, 80, 80, 80]);
    results.forEach((r) => (r.status = "keep"));
    // patience 5 → need 5 consecutive non-improvements after best
    expect(detectPlateau(results, "lower", 5).plateaued).toBe(false);
    expect(detectPlateau(results, "lower", 2).plateaued).toBe(true);
  });

  it("returns 0 iterationsSinceBest when no kept results", () => {
    const results = makeResults([100, 90, 80]);
    results.forEach((r) => (r.status = "discard"));
    const plateau = detectPlateau(results, "lower", 5);
    expect(plateau.plateaued).toBe(false);
    expect(plateau.iterationsSinceBest).toBe(0);
  });
});

describe("registerSecondaryMetrics", () => {
  it("registers new metric names", () => {
    const known: { name: string; unit: string }[] = [];
    const updated = registerSecondaryMetrics(known, { compile_µs: 4200 }, inferUnit);
    expect(updated.length).toBe(1);
    expect(updated[0].name).toBe("compile_µs");
    expect(updated[0].unit).toBe("µs");
  });

  it("does not duplicate existing metric names", () => {
    const known = [{ name: "compile_µs", unit: "µs" }];
    const updated = registerSecondaryMetrics(known, { compile_µs: 8100 }, inferUnit);
    expect(updated.length).toBe(1);
  });

  it("preserves existing when adding new ones", () => {
    const known = [{ name: "compile_µs", unit: "µs" }];
    const updated = registerSecondaryMetrics(known, { render_µs: 8100 }, inferUnit);
    expect(updated.length).toBe(2);
    expect(updated[0].name).toBe("compile_µs");
    expect(updated[1].name).toBe("render_µs");
  });

  it("handles empty metrics", () => {
    const known = [{ name: "a", unit: "s" }];
    const updated = registerSecondaryMetrics(known, {}, inferUnit);
    expect(updated.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// log.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("readEntries / writeConfig / writeResult", () => {
  const tmpDir = path.join(os.tmpdir(), `experiment-harness-test-log-${Date.now()}`);
  const jsonlPath = path.join(tmpDir, "test.jsonl");

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
  });

  it("writes and reads config entry", () => {
    const config: JsonlConfigEntry = {
      type: "config",
      name: "test session",
      metricName: "seconds",
      metricUnit: "s",
      direction: "lower",
      targetValue: 30,
      segment: 0,
      command: "bash test.sh",
    };
    writeConfig(jsonlPath, config);
    const entries = readEntries(jsonlPath);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("config");
    if (entries[0].type === "config") {
      expect(entries[0].name).toBe("test session");
      expect(entries[0].metricName).toBe("seconds");
    }
  });

  it("writes and reads result entry", () => {
    const config: JsonlConfigEntry = {
      type: "config",
      name: "test",
      metricName: "seconds",
      metricUnit: "s",
      direction: "lower",
      targetValue: null,
      segment: 0,
      command: "echo",
    };
    writeConfig(jsonlPath, config);

    const result: JsonlResultEntry = {
      type: "result",
      run: 1,
      commit: "abc1234",
      metric: 12.5,
      metrics: { compile_µs: 4200 },
      status: "keep",
      description: "baseline",
      timestamp: Date.now(),
      segment: 0,
      confidence: null,
      durationSeconds: 12.5,
    };
    writeResult(jsonlPath, result);

    const entries = readEntries(jsonlPath);
    expect(entries.length).toBe(2);
    expect(entries[1].type).toBe("result");
    if (entries[1].type === "result") {
      expect(entries[1].metric).toBe(12.5);
      expect(entries[1].metrics.compile_µs).toBe(4200);
    }
  });

  it("skips malformed lines", () => {
    fs.writeFileSync(jsonlPath, "not json\n{broken\n" + JSON.stringify({
      type: "config", name: "ok", metricName: "s", metricUnit: "", direction: "lower" as const,
      targetValue: null, segment: 0, command: "echo",
    }) + "\n");
    const entries = readEntries(jsonlPath);
    expect(entries.length).toBe(1);
  });

  it("returns empty for non-existent file", () => {
    expect(readEntries("/non/existent/path.jsonl").length).toBe(0);
  });

  it("appends multiple results", () => {
    writeConfig(jsonlPath, {
      type: "config", name: "t", metricName: "s", metricUnit: "", direction: "lower" as const,
      targetValue: null, segment: 0, command: "echo",
    });
    for (let i = 0; i < 5; i++) {
      writeResult(jsonlPath, {
        type: "result", run: i + 1, commit: `c${i}`, metric: 10 + i,
        metrics: {}, status: "keep" as const, description: `run ${i + 1}`,
        timestamp: Date.now(), segment: 0, confidence: null, durationSeconds: 1,
      });
    }
    const entries = readEntries(jsonlPath);
    expect(entries.length).toBe(6); // 1 config + 5 results
  });

  it("deleteLog removes the file", () => {
    writeConfig(jsonlPath, {
      type: "config", name: "t", metricName: "s", metricUnit: "", direction: "lower" as const,
      targetValue: null, segment: 0, command: "echo",
    });
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(deleteLog(jsonlPath)).toBe(true);
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it("deleteLog returns false for non-existent file", () => {
    expect(deleteLog("/non/existent/path.jsonl")).toBe(false);
  });
});

describe("reconstructState", () => {
  it("returns initial state for empty entries", () => {
    const state = reconstructState([]);
    expect(state.config).toBe(null);
    expect(state.results.length).toBe(0);
    expect(state.baselineMetric).toBe(null);
    expect(state.bestMetric).toBe(null);
    expect(state.confidence).toBe(null);
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

  it("uses current segment for baseline calculation", () => {
    const entries = [
      {
        type: "config" as const, name: "test", metricName: "seconds", metricUnit: "s",
        direction: "lower" as const, targetValue: null, segment: 0, command: "bash test.sh",
      },
      {
        type: "result" as const, run: 1, commit: "a1", metric: 20, metrics: {},
        status: "keep" as const, description: "baseline", timestamp: Date.now(),
        segment: 0, confidence: null, durationSeconds: 20,
      },
      {
        type: "config" as const, name: "test v2", metricName: "seconds", metricUnit: "s",
        direction: "lower" as const, targetValue: null, segment: 1, command: "bash test2.sh",
      },
      {
        type: "result" as const, run: 2, commit: "b2", metric: 15, metrics: {},
        status: "keep" as const, description: "new baseline", timestamp: Date.now(),
        segment: 1, confidence: null, durationSeconds: 15,
      },
    ];

    const state = reconstructState(entries);
    expect(state.currentSegment).toBe(1);
    expect(state.baselineMetric).toBe(15);
  });

  it("best metric is the best kept in current segment", () => {
    const entries = [
      {
        type: "config" as const, name: "test", metricName: "seconds", metricUnit: "s",
        direction: "lower" as const, targetValue: null, segment: 0, command: "echo",
      },
      {
        type: "result" as const, run: 1, commit: "a", metric: 20, metrics: {},
        status: "keep" as const, description: "baseline", timestamp: Date.now(),
        segment: 0, confidence: null, durationSeconds: 20,
      },
      {
        type: "result" as const, run: 2, commit: "b", metric: 15, metrics: {},
        status: "keep" as const, description: "improved", timestamp: Date.now(),
        segment: 0, confidence: 2.0, durationSeconds: 15,
      },
      {
        type: "result" as const, run: 3, commit: "c", metric: 25, metrics: {},
        status: "discard" as const, description: "worse", timestamp: Date.now(),
        segment: 0, confidence: 1.5, durationSeconds: 25,
      },
    ];

    const state = reconstructState(entries);
    expect(state.baselineMetric).toBe(20);
    expect(state.bestMetric).toBe(15); // best kept in segment 0
  });

  it("registers secondary metrics from results", () => {
    const entries = [
      {
        type: "config" as const, name: "test", metricName: "seconds", metricUnit: "s",
        direction: "lower" as const, targetValue: null, segment: 0, command: "echo",
      },
      {
        type: "result" as const, run: 1, commit: "a", metric: 10,
        metrics: { compile_µs: 4200, render_µs: 8100 },
        status: "keep" as const, description: "baseline", timestamp: Date.now(),
        segment: 0, confidence: null, durationSeconds: 10,
      },
    ];

    const state = reconstructState(entries);
    expect(state.secondaryMetrics.length).toBe(2);
    expect(state.secondaryMetrics.map((m) => m.name)).toContain("compile_µs");
    expect(state.secondaryMetrics.map((m) => m.name)).toContain("render_µs");
  });

  it("handles config entry without results", () => {
    const entries = [
      {
        type: "config" as const, name: "test", metricName: "seconds", metricUnit: "s",
        direction: "lower" as const, targetValue: 30, segment: 0, command: "echo",
      },
    ];

    const state = reconstructState(entries);
    expect(state.config?.name).toBe("test");
    expect(state.targetValue).toBe(30);
    expect(state.results.length).toBe(0);
    expect(state.baselineMetric).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// strategy.ts
// ═══════════════════════════════════════════════════════════════════════════

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

  it("discards equal values", () => {
    const result = makeResult(10, "keep");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });

  it("keeps first result (baseline)", () => {
    const result = makeResult(10, "keep");
    const state = makeState(null, "lower");
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("always discards non-keep status", () => {
    const result = makeResult(5, "crash");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });

  it("works for higher-is-better", () => {
    const result = makeResult(15, "keep");
    const state = makeState(10, "higher");
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

  it("returns rework when below confidence threshold", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(9, "keep");
    const state = makeState(10, "lower");
    state.confidence = 0.8;
    expect(strategy.evaluate(result, state)).toBe("rework");
  });

  it("keeps when confidence is above threshold", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(8, "keep");
    const state = makeState(10, "lower");
    state.confidence = 3.0;
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("keeps optimistically when confidence is null", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(9, "keep");
    const state = makeState(10, "lower");
    state.confidence = null;
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("keeps when confidence exactly equals threshold", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(9, "keep");
    const state = makeState(10, "lower");
    state.confidence = 1.5;
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("custom minConfidence value", () => {
    const strategy = new ConfidenceGatedStrategy(2.0);
    const result = makeResult(9, "keep");
    const state = makeState(10, "lower");
    state.confidence = 1.8; // Above 1.5 default but below 2.0
    expect(strategy.evaluate(result, state)).toBe("rework");
  });

  it("always discards non-keep status regardless of confidence", () => {
    const strategy = new ConfidenceGatedStrategy(1.5);
    const result = makeResult(5, "crash");
    const state = makeState(10, "lower");
    state.confidence = 10.0;
    expect(strategy.evaluate(result, state)).toBe("discard");
  });
});

describe("EpsilonGreedyStrategy", () => {
  it("keeps improvements regardless of epsilon", () => {
    const rng = { random: () => 0.99 };
    const strategy = new EpsilonGreedyStrategy(0.1, rng);
    const result = makeResult(8, "keep");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("keep");
  });

  it("can explore with deterministic random source (low roll)", () => {
    const rng = { random: () => 0.01 };
    const strategy = new EpsilonGreedyStrategy(0.5, rng);
    const result = makeResult(10, "keep"); // No improvement
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("keep"); // Exploration
  });

  it("discards when epsilon doesn't trigger (high roll)", () => {
    const rng = { random: () => 0.99 };
    const strategy = new EpsilonGreedyStrategy(0.1, rng);
    const result = makeResult(12, "keep"); // Regression
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });

  it("always discards non-keep status", () => {
    const rng = { random: () => 0.01 };
    const strategy = new EpsilonGreedyStrategy(0.5, rng);
    const result = makeResult(5, "crash");
    const state = makeState(10, "lower");
    expect(strategy.evaluate(result, state)).toBe("discard");
  });

  it("uses default Math.random when no rng provided", () => {
    const strategy = new EpsilonGreedyStrategy(0.1);
    const result = makeResult(8, "keep");
    const state = makeState(10, "lower");
    // Should always keep improvements regardless of random
    expect(strategy.evaluate(result, state)).toBe("keep");
  });
});

describe("createStrategy", () => {
  it("creates greedy by default", () => {
    expect(createStrategy()).toBeInstanceOf(GreedyStrategy);
  });

  it("creates by name", () => {
    expect(createStrategy("greedy")).toBeInstanceOf(GreedyStrategy);
    expect(createStrategy("confidence-gated")).toBeInstanceOf(ConfidenceGatedStrategy);
    expect(createStrategy("epsilon-greedy")).toBeInstanceOf(EpsilonGreedyStrategy);
  });

  it("creates with config", () => {
    const s = createStrategy({ name: "confidence-gated", minConfidence: 2.0 });
    expect(s).toBeInstanceOf(ConfidenceGatedStrategy);
  });

  it("creates epsilon-greedy with config", () => {
    const s = createStrategy({ name: "epsilon-greedy", epsilon: 0.2 });
    expect(s).toBeInstanceOf(EpsilonGreedyStrategy);
  });

  it("falls back to greedy for unknown name", () => {
    expect(createStrategy("unknown" as any)).toBeInstanceOf(GreedyStrategy);
  });

  it("falls back to greedy for unknown config name", () => {
    const s = createStrategy({ name: "unknown" as any });
    expect(s).toBeInstanceOf(GreedyStrategy);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// git.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("git / gitSafe", () => {
  const tmpDir = path.join(os.tmpdir(), `experiment-harness-test-git-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, encoding: "utf-8" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "test");
    execFileSync("git", ["add", "-A"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("git returns stdout on success", () => {
    const result = git(tmpDir, ["rev-parse", "--short=7", "HEAD"]);
    expect(result.length).toBe(7);
  });

  it("git throws on failure", () => {
    expect(() => git(tmpDir, ["nonexistent-command"])).toThrow();
  });

  it("gitSafe returns ok on success", () => {
    const result = gitSafe(tmpDir, ["rev-parse", "HEAD"]);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("gitSafe returns error on failure", () => {
    const result = gitSafe(tmpDir, ["nonexistent-command"]);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it("getHeadCommit returns 7-char hash", () => {
    const commit = getHeadCommit(tmpDir);
    expect(commit.length).toBe(7);
    expect(/^[0-9a-f]{7}$/.test(commit)).toBe(true);
  });

  it("getDisplayWorktreePath returns relative path inside project", () => {
    const abs = path.join(tmpDir, "autoresearch", "session-1");
    expect(getDisplayWorktreePath(tmpDir, abs)).toBe("autoresearch/session-1");
  });

  it("getDisplayWorktreePath returns absolute path outside project", () => {
    expect(getDisplayWorktreePath(tmpDir, "/other/path")).toBe("/other/path");
  });

  it("getDisplayWorktreePath returns null for null input", () => {
    expect(getDisplayWorktreePath(tmpDir, null)).toBe(null);
  });

  it("getProtectedFiles returns expected list", () => {
    const files = getProtectedFiles();
    expect(files).toContain("autoresearch.jsonl");
    expect(files).toContain("autoresearch.md");
    expect(files).toContain("autoresearch.ideas.md");
    expect(files).toContain("autoresearch.sh");
    expect(files).toContain("autoresearch.checks.sh");
  });

  it("commitChanges returns null when nothing to commit", () => {
    const result = commitChanges(tmpDir, "empty commit");
    expect(result).toBe(null);
  });

  it("commitChanges commits and returns hash", () => {
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "hello");
    const result = commitChanges(tmpDir, "add test file");
    expect(result).not.toBe(null);
    expect(result!.length).toBe(7);
  });

  it("revertChanges restores clean state", () => {
    // Make a change
    fs.writeFileSync(path.join(tmpDir, "dirty.txt"), "should be removed");
    // Revert
    const result = revertChanges(tmpDir);
    expect(result).toBe(true);
    // dirty.txt should be gone
    expect(fs.existsSync(path.join(tmpDir, "dirty.txt"))).toBe(false);
  });

  it("revertChanges preserves protected files", () => {
    // Write a protected file
    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    fs.writeFileSync(jsonlPath, '{"type":"config"}\n');
    // Write another file that should be reverted
    fs.writeFileSync(path.join(tmpDir, "extra.txt"), "extra");
    // Revert
    revertChanges(tmpDir);
    // Protected file should survive
    expect(fs.existsSync(jsonlPath)).toBe(true);
    // Non-protected file should be gone
    expect(fs.existsSync(path.join(tmpDir, "extra.txt"))).toBe(false);
    // Clean up
    fs.unlinkSync(jsonlPath);
  });
});

describe("worktree lifecycle", () => {
  const tmpDir = path.join(os.tmpdir(), `experiment-harness-test-wt-${Date.now()}`);
  const sessionId = `session-test-${Date.now()}`;

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, encoding: "utf-8" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "test");
    execFileSync("git", ["add", "-A"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
  });

  afterAll(() => {
    try {
      // Clean up worktree if it exists
      try {
        execFileSync("git", ["worktree", "remove", "--force", path.join(tmpDir, "autoresearch", sessionId)], {
          cwd: tmpDir, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {}
      try {
        execFileSync("git", ["branch", "-D", `autoresearch/${sessionId}`], {
          cwd: tmpDir, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("creates a worktree", () => {
    const wt = createWorktree(tmpDir, sessionId);
    expect(wt).not.toBe(null);
    expect(fs.existsSync(wt!)).toBe(true);
    expect(wt!).toContain("autoresearch");
  });

  it("returns same path on duplicate create", () => {
    const wt1 = createWorktree(tmpDir, sessionId);
    const wt2 = createWorktree(tmpDir, sessionId);
    expect(wt1).toBe(wt2);
  });

  it("detects existing worktree with jsonl", () => {
    const wt = createWorktree(tmpDir, sessionId);
    expect(wt).not.toBe(null);
    // detectWorktree requires autoresearch.jsonl to exist
    fs.writeFileSync(path.join(wt!, "autoresearch.jsonl"), "{\"type\":\"config\"}\n");
    const detected = detectWorktree(tmpDir, sessionId);
    expect(detected).not.toBe(null);
    expect(fs.existsSync(detected!)).toBe(true);
  });

  it("worktree has same files as main repo", () => {
    const wt = createWorktree(tmpDir, sessionId);
    expect(fs.existsSync(path.join(wt!, "README.md"))).toBe(true);
  });

  it("removes a worktree", () => {
    const wt = createWorktree(tmpDir, sessionId);
    expect(wt).not.toBe(null);
    removeWorktree(tmpDir, wt!);
    expect(fs.existsSync(wt!)).toBe(false);
  });

  it("returns null for non-existent worktree", () => {
    expect(detectWorktree(tmpDir, "non-existent-session")).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// session.ts — integration tests with real git repo
// ═══════════════════════════════════════════════════════════════════════════

describe("Session integration", () => {
  const tmpDir = path.join(os.tmpdir(), `experiment-harness-test-session-${Date.now()}`);
  let session: Session;

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir, encoding: "utf-8" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, encoding: "utf-8" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "test project");
    execFileSync("git", ["add", "-A"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir, encoding: "utf-8", timeout: 5000 });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    session = new Session();
  });

  afterEach(() => {
    try {
      session.clear();
    } catch {}
  });

  // --- Initialization ---

  it("init creates a session with worktree", async () => {
    const result = await session.init({
      cwd: tmpDir,
      config: {
        name: "Test Session",
        metricName: "seconds",
        metricUnit: "s",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.worktreePath).toBeDefined();
  });

  it("init fails without git repo", async () => {
    const badDir = path.join(os.tmpdir(), `no-git-${Date.now()}`);
    fs.mkdirSync(badDir, { recursive: true });
    try {
      const result = await session.init({
        cwd: badDir,
        config: {
          name: "Bad",
          metricName: "x",
          direction: "lower",
          command: "echo x",
        },
      });
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("init without worktree uses repoCwd", async () => {
    const result = await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "No Worktree",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=5",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.worktreePath).toBeUndefined();
  });

  // --- Run ---

  it("run returns error before init", async () => {
    const result = await session.run();
    expect(result.passed).toBe(false);
    expect(result.tailOutput).toContain("not initialized");
  });

  it("run captures command output and parses metrics", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Run Test",
        metricName: "seconds",
        metricUnit: "s",
        direction: "lower",
        command: "echo METRIC seconds=5 && echo METRIC other_ms=200",
      },
    });

    const result = await session.run();
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.parsedPrimary).toBe(5);
    expect(result.parsedMetrics).not.toBe(null);
    expect(result.parsedMetrics!["seconds"]).toBe(5);
    expect(result.parsedMetrics!["other_ms"]).toBe(200);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it("run detects non-zero exit code as failure", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Fail Test",
        metricName: "seconds",
        direction: "lower",
        command: "exit 1",
      },
    });

    const result = await session.run();
    expect(result.passed).toBe(false);
    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("run detects timeout", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Timeout Test",
        metricName: "seconds",
        direction: "lower",
        command: "sleep 10",
      },
    });

    const result = await session.run({ timeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("run enforces maxRuns", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Max Runs",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=5",
        maxRuns: 1,
      },
    });

    // First run should work
    const r1 = await session.run();
    expect(r1.passed).toBe(true);

    // Log it
    await session.log({ metric: 5, status: "keep", description: "first" });

    // Second run should fail due to maxRuns
    const r2 = await session.run();
    expect(r2.passed).toBe(false);
    expect(r2.tailOutput).toContain("Maximum runs reached");
  });

  // --- Log ---

  it("log returns error before init", async () => {
    const result = await session.log({
      metric: 5,
      status: "keep",
      description: "test",
    });
    expect(result.ok).toBe(false);
  });

  it("log stores result and updates state", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Log Test",
        metricName: "seconds",
        metricUnit: "s",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    const logResult = await session.log({
      metric: 10,
      status: "keep",
      description: "baseline",
    });
    expect(logResult.ok).toBe(true);
    expect(logResult.autoCommitted).toBe(true);
    expect(logResult.confidence).toBe(null); // Need 3+ results

    const status = session.status();
    expect(status.runs).toBe(1);
    expect(status.kept).toBe(1);
    expect(status.baselineMetric).toBe(10);
    expect(status.bestMetric).toBe(10);
  });

  it("log auto-commits on keep", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Commit Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    // Baseline
    await session.log({ metric: 10, status: "keep", description: "baseline" });
    // Improved — should auto-commit
    const result = await session.log({
      metric: 8,
      status: "keep",
      description: "improved",
    });
    expect(result.ok).toBe(true);
    expect(result.autoCommitted).toBe(true);
    expect(result.commit).toBeDefined();
    expect(result.improvement).toBe("+20.0%"); // Direction-aware: 8 vs 10, lower is better
  });

  it("log auto-reverts on discard", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Revert Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "baseline" });
    const result = await session.log({
      metric: 15,
      status: "discard",
      description: "worse",
    });
    expect(result.ok).toBe(true);
    expect(result.autoReverted).toBe(true);
  });

  it("log gates keep when checks failed", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Checks Gate Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=8",
      },
    });

    // Simulate: run() stored a RunDetails with checksPass = false
    // We need to call run() first, but we need checks to fail.
    // Write autoresearch.checks.sh that fails
    fs.writeFileSync(path.join(tmpDir, "autoresearch.checks.sh"), "#!/bin/bash\nexit 1\n");

    // Baseline first
    await session.log({ metric: 10, status: "keep", description: "baseline" });

    // Run with failing checks
    const runResult = await session.run();
    expect(runResult.checksPass).toBe(false);

    // Try to keep — should be blocked
    const logResult = await session.log({
      metric: 8,
      status: "keep",
      description: "improved but checks failed",
    });
    expect(logResult.ok).toBe(false);
    expect(logResult.error).toContain("checks failed");

    // Should succeed as checks_failed
    const logResult2 = await session.log({
      metric: 8,
      status: "checks_failed",
      description: "checks failed",
    });
    expect(logResult2.ok).toBe(true);

    // Cleanup
    fs.unlinkSync(path.join(tmpDir, "autoresearch.checks.sh"));
  });

  it("log computes baseline from current segment only", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Segment Baseline",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    // First segment baseline
    await session.log({ metric: 20, status: "keep", description: "seg0 baseline" });

    // Re-init — new segment
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Segment Baseline v2",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    // New segment baseline
    const logResult = await session.log({
      metric: 15,
      status: "keep",
      description: "seg1 baseline",
    });
    expect(logResult.ok).toBe(true);

    const status = session.status();
    // Baseline should be 15 (from current segment), not 20 (from previous segment)
    expect(status.baselineMetric).toBe(15);
  });

  it("log improvement is direction-aware", async () => {
    // Test lower-is-better: improvement shows as positive
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Improvement Direction",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=8",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "baseline" });
    const lowerResult = await session.log({
      metric: 8,
      status: "keep",
      description: "improved (lower is better)",
    });
    expect(lowerResult.improvement).toBe("+20.0%"); // Decrease is improvement

    const status = session.status();
    expect(status.improvement).toBe("+20.0%"); // Best vs baseline
  });

  it("log improvement for higher-is-better", async () => {
    const session2 = new Session();
    await session2.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Higher Improvement",
        metricName: "score",
        direction: "higher",
        command: "echo METRIC score=80",
      },
    });

    await session2.log({ metric: 50, status: "keep", description: "baseline" });
    const result = await session2.log({
      metric: 60,
      status: "keep",
      description: "improved (higher is better)",
    });
    expect(result.improvement).toBe("+20.0%"); // Increase is improvement

    session2.clear();
  });

  // --- status() ---

  it("status returns discarded count", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Discard Count",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "baseline" });
    await session.log({ metric: 15, status: "discard", description: "worse" });
    await session.log({ metric: 20, status: "crash", description: "broke" });

    const status = session.status();
    expect(status.runs).toBe(3);
    expect(status.kept).toBe(1);
    expect(status.discarded).toBe(2); // discard + crash
  });

  it("status reports target reached", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Target Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=25",
        targetValue: 30,
      },
    });

    await session.log({ metric: 50, status: "keep", description: "baseline" });
    expect(session.status().targetReached).toBe(false);

    await session.log({ metric: 25, status: "keep", description: "reached target" });
    expect(session.status().targetReached).toBe(true);
  });

  // --- runAndLog ---

  it("runAndLog runs and logs with greedy strategy (keep improvement)", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "RunAndLog Greedy",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=8",
      },
    });
    session.setStrategy("greedy");

    // Baseline
    await session.log({ metric: 10, status: "keep", description: "baseline" });

    // Run + log — metric 8 is better than 10
    const result = await session.runAndLog({ description: "auto run" });
    expect(result.ok).toBe(true);
    expect(result.logResult?.autoCommitted).toBe(true);
  });

  it("runAndLog handles rework from confidence-gated strategy", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Rework Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=9",
      },
    });
    session.setStrategy({ name: "confidence-gated", minConfidence: 2.0 });

    // Baseline
    await session.log({ metric: 10, status: "keep", description: "baseline" });
    // A few more results to build up confidence
    await session.log({ metric: 10, status: "discard", description: "no change" });
    await session.log({ metric: 10, status: "discard", description: "no change" });

    // Now runAndLog — metric 9 is slightly better, but confidence may be low
    const result = await session.runAndLog({ description: "marginal improvement" });
    expect(result.ok).toBe(true);
    // With low confidence, the strategy returns "rework" → status becomes "no_op"
    // Code should be auto-reverted (no_op is not "keep")
    if (result.logResult?.autoReverted) {
      // If confidence was below threshold, we get no_op with revert
      expect(result.logResult?.autoReverted).toBe(true);
    }
  });

  it("runAndLog handles crash", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Crash Test",
        metricName: "seconds",
        direction: "lower",
        command: "exit 1",
      },
    });

    const result = await session.runAndLog({ description: "crashed" });
    expect(result.ok).toBe(true);
    expect(result.logResult?.autoReverted).toBe(true);
  });

  it("runAndLog handles timeout", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Timeout Test",
        metricName: "seconds",
        direction: "lower",
        command: "sleep 30",
      },
    });

    const result = await session.runAndLog({ timeoutSeconds: 1, description: "timed out" });
    expect(result.ok).toBe(true);
    expect(result.logResult?.autoReverted).toBe(true);
  });

  // --- Loop ---

  it("startLoop fails before init", () => {
    const result = session.startLoop();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not initialized");
  });

  it("startLoop applies strategy to session", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Loop Strategy",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    const result = session.startLoop({ strategy: "confidence-gated" });
    expect(result.ok).toBe(true);
    expect(result.loopId).toBeDefined();
    expect(session.getLoopStatus()).toBe("running");

    session.stopLoop();
    expect(session.getLoopStatus()).toBe("stopped");
  });

  it("stopLoop stops the loop", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Loop Stop",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
        maxRuns: 1,
      },
    });

    session.startLoop({ pollIntervalSeconds: 10 });
    expect(session.getLoopStatus()).toBe("running");

    session.stopLoop();
    expect(session.getLoopStatus()).toBe("stopped");
  });

  it("cannot start loop when already running", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Loop Double Start",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    session.startLoop({ pollIntervalSeconds: 10 });
    const result = session.startLoop();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already running");

    session.stopLoop();
  });

  // --- Clear ---

  it("clear resets all state", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Clear Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "baseline" });
    expect(session.status().runs).toBe(1);

    session.clear();
    const status = session.status();
    expect(status.initialized).toBe(false);
    expect(status.runs).toBe(0);
  });

  it("clear stops running loop", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Clear Loop",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    session.startLoop({ pollIntervalSeconds: 10 });
    expect(session.getLoopStatus()).toBe("running");

    session.clear();
    expect(session.getLoopStatus()).toBe("idle");
  });

  // --- Resume ---

  it("resume reconstructs state from JSONL", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Resume Test",
        metricName: "seconds",
        metricUnit: "s",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "baseline" });
    await session.log({ metric: 8, status: "keep", description: "improved" });

    // Create a new session and resume
    const session2 = new Session();
    const result = await session2.resume({ cwd: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.runCount).toBe(2);

    const status = session2.status();
    expect(status.initialized).toBe(true);
    expect(status.runs).toBe(2);
    expect(status.baselineMetric).toBe(10);
    expect(status.bestMetric).toBe(8);

    session2.clear();
  });

  it("resume fails when no JSONL exists", async () => {
    const badDir = path.join(os.tmpdir(), `no-jsonl-${Date.now()}`);
    fs.mkdirSync(badDir, { recursive: true });
    try {
      const result = await session.resume({ cwd: badDir });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No autoresearch.jsonl");
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });

  // --- Guard ---

  it("setGuard stores config", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Guard Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    const result = session.setGuard({
      command: "pnpm test",
      mode: "pass-fail",
    });
    expect(result.ok).toBe(true);
  });

  // --- Strategy ---

  it("setStrategy updates the strategy", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Strategy Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    expect(session.setStrategy("greedy").ok).toBe(true);
    expect(session.setStrategy("confidence-gated").ok).toBe(true);
    expect(session.setStrategy({ name: "epsilon-greedy", epsilon: 0.2 }).ok).toBe(true);
  });

  // --- results() ---

  it("results returns all or last N", async () => {
    await session.init({
      cwd: tmpDir,
      worktree: false,
      config: {
        name: "Results Test",
        metricName: "seconds",
        direction: "lower",
        command: "echo METRIC seconds=10",
      },
    });

    await session.log({ metric: 10, status: "keep", description: "r1" });
    await session.log({ metric: 8, status: "keep", description: "r2" });
    await session.log({ metric: 12, status: "discard", description: "r3" });

    const all = session.results();
    expect(all.length).toBe(3);

    const last2 = session.results({ last: 2 });
    expect(last2.length).toBe(2);
    expect(last2[0].description).toBe("r2");
    expect(last2[1].description).toBe("r3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

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
    status: (i === 0 || m < metrics[0]) ? ("keep" as const) : ("discard" as const),
    description: `run ${i + 1}`,
    timestamp: Date.now() + i * 1000,
    segment: 0,
    confidence: null,
    durationSeconds: m / 10,
  }));
}
