/**
 * Core type definitions for experiment-harness.
 */

// ---------------------------------------------------------------------------
// Metrics & Parsing
// ---------------------------------------------------------------------------

/** Metric names that could cause prototype pollution if used as object keys. */
export const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = "METRIC";

// ---------------------------------------------------------------------------
// Session Config
// ---------------------------------------------------------------------------

export interface SessionConfig {
  name: string;
  metricName: string;
  metricUnit?: string;
  direction: "lower" | "higher";
  command: string;
  targetValue?: number;
  maxRuns?: number;
  checksTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Experiment Results
// ---------------------------------------------------------------------------

export type ExperimentStatus =
  | "keep"
  | "discard"
  | "crash"
  | "checks_failed"
  | "timeout"
  | "metric_error"
  | "no_op"
  | "hook_blocked";

export interface ExperimentResult {
  /** Sequential run number (1-based). */
  run: number;
  /** Git commit hash (7-char). */
  commit: string;
  /** Primary metric value. */
  metric: number;
  /** Additional tracked metrics. */
  metrics: Record<string, number>;
  /** Status of this experiment. */
  status: ExperimentStatus;
  /** One-sentence description. */
  description: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Segment index (incremented on each init). */
  segment: number;
  /** Confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Actionable Side Information — free-form diagnostics. */
  asi?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type StrategyName = "greedy" | "confidence-gated" | "epsilon-greedy";

export interface StrategyConfig {
  name: StrategyName;
  /** For confidence-gated: minimum confidence to auto-keep. */
  minConfidence?: number;
  /** For epsilon-greedy: probability of keeping a marginal improvement. */
  epsilon?: number;
}

export type StrategyDecision = "keep" | "discard" | "rework";

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface LoopOptions {
  maxRuns?: number;
  strategy?: StrategyName | StrategyConfig;
  /** Seconds to wait between file-change polls. Default: 2. */
  pollIntervalSeconds?: number;
  /** Auto-stop when target value reached. Default: true. */
  stopOnTarget?: boolean;
  /** Number of consecutive non-improvements before plateau. Default: 15. */
  plateauPatience?: number;
}

export type LoopStatus = "idle" | "running" | "paused" | "stopped" | "completed";

// ---------------------------------------------------------------------------
// Run Details (returned by session.run())
// ---------------------------------------------------------------------------

export interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run. true/false = ran. */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics. null if not found. */
  parsedPrimary: number | null;
  metricName: string;
  metricUnit: string;
  /** Full output saved to temp file if truncated. */
  fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// Session State (persisted to JSONL)
// ---------------------------------------------------------------------------

export interface MetricDef {
  name: string;
  unit: string;
}

export interface SessionState {
  config: SessionConfig | null;
  results: ExperimentResult[];
  baselineMetric: number | null;
  bestMetric: number | null;
  direction: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  currentSegment: number;
  confidence: number | null;
  targetValue: number | null;
  maxRuns: number | null;
}

// ---------------------------------------------------------------------------
// JSONL Log Entries
// ---------------------------------------------------------------------------

export interface JsonlConfigEntry {
  type: "config";
  name: string;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher";
  targetValue: number | null;
  segment: number;
  command: string;
}

export interface JsonlResultEntry {
  type: "result";
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: ExperimentStatus;
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  durationSeconds: number;
  asi?: Record<string, unknown>;
}

export type JsonlEntry = JsonlConfigEntry | JsonlResultEntry;
