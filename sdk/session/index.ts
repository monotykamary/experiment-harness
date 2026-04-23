/**
 * Session — the core experiment session object.
 *
 * Holds all state for a single experiment session: config, results,
 * worktree, guard, strategy. Persists to JSONL. Reconstructs from JSONL.
 * Provides the API that the server exposes via /eval.
 *
 * Heavy lifting is delegated to:
 *   session/process.ts — process spawning, temp files, kill-tree
 *   session/run.ts     — execute benchmark, checks, metric parsing
 *   session/loop.ts    — autonomous loop controller
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type {
  SessionConfig,
  SessionState,
  ExperimentResult,
  ExperimentStatus,
  RunDetails,
  GuardConfig,
  StrategyConfig,
  LoopOptions,
  LoopStatus,
  JsonlConfigEntry,
  JsonlResultEntry,
  StrategyName,
} from "../types.ts";
import { inferUnit } from "../parse.ts";
import {
  isBetter,
  computeConfidence,
  registerSecondaryMetrics,
  formatImprovement,
} from "../stats.ts";
import {
  reconstructState,
  writeConfig as writeJsonlConfig,
  writeResult as writeJsonlResult,
  readEntries,
  deleteLog,
} from "../log.ts";
import {
  createWorktree,
  removeWorktree,
  commitChanges,
  revertChanges,
  getHeadCommit,
  detectWorktree,
  getDisplayWorktreePath,
} from "../git.ts";
import { createStrategy, type Strategy } from "../strategy.ts";
import { executeRun, makeErrorRunDetails } from "./run.ts";
import { LoopController, type LoopHost } from "./loop.ts";
import { createTempFileAllocator } from "./process.ts";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session implements LoopHost {
  // Project root (where the git repo lives)
  private repoCwd: string = "";
  // Working directory (worktree if active, otherwise repoCwd)
  /** @internal */ workDir: string = "";
  // Worktree path (null if not using worktree isolation)
  private worktreeDir: string | null = null;

  // JSONL log path (resolved after workDir is set)
  private jsonlPath: string = "";

  // Session state (source of truth is the JSONL, this is the in-memory mirror)
  private state: SessionState;

  // Strategy for keep/discard decisions
  private strategy: Strategy;

  // Last run details (used to gate log() on failed checks)
  private lastRunDetails: RunDetails | null = null;

  // Temp files created during runs (cleaned up on clear())
  private tempFiles: Set<string> = new Set();

  // Loop controller (extracted from session)
  private loop: LoopController;

  // Session ID (used for worktree naming)
  private sessionId: string = "";

  constructor() {
    this.state = this.createInitialState();
    this.strategy = createStrategy();
    this.loop = new LoopController();
  }

  private createInitialState(): SessionState {
    return {
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
  }

  // -----------------------------------------------------------------------
  // LoopHost interface (used by LoopController)
  // -----------------------------------------------------------------------

  /** Current direction — exposed for LoopHost. */
  get direction(): "lower" | "higher" {
    return this.state.direction;
  }

  /** Current max runs — exposed for LoopHost. */
  get maxRuns(): number | null {
    return this.state.maxRuns;
  }

  /** Update loop status — called by LoopController. */
  setLoopStatus(status: LoopStatus): void {
    // The loop controller manages its own status;
    // this is a no-op hook for future extensibility.
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Initialize a new experiment session.
   * Creates a worktree, writes config to JSONL, and establishes baseline.
   */
  async init(opts: {
    cwd: string;
    sessionId?: string;
    config: SessionConfig;
    worktree?: boolean;
  }): Promise<{ ok: boolean; error?: string; worktreePath?: string }> {
    this.repoCwd = opts.cwd;
    this.sessionId = opts.sessionId ?? `session-${Date.now()}`;
    const config = opts.config;

    // Create worktree for isolation (default: on)
    if (opts.worktree !== false) {
      const wt = createWorktree(this.repoCwd, this.sessionId);
      if (!wt) {
        return { ok: false, error: "Failed to create worktree — isolation required" };
      }
      this.worktreeDir = wt;
      this.workDir = wt;
    } else {
      this.workDir = this.repoCwd;
    }

    // Set up JSONL path
    this.jsonlPath = path.join(this.workDir, "autoresearch.jsonl");

    // Increment segment on re-init
    if (this.state.config) {
      this.state.currentSegment++;
      this.state.baselineMetric = null;
      this.state.bestMetric = null;
      this.state.secondaryMetrics = [];
      this.state.confidence = null;
    }

    // Update state from config
    this.state.config = config;
    this.state.metricName = config.metricName;
    this.state.metricUnit = config.metricUnit ?? "";
    this.state.direction = config.direction;
    this.state.targetValue = config.targetValue ?? null;
    this.state.maxRuns = config.maxRuns ?? null;

    // Write config header to JSONL
    const configEntry: JsonlConfigEntry = {
      type: "config",
      name: config.name,
      metricName: config.metricName,
      metricUnit: config.metricUnit ?? "",
      direction: config.direction,
      targetValue: this.state.targetValue,
      segment: this.state.currentSegment,
      command: config.command,
    };
    writeJsonlConfig(this.jsonlPath, configEntry);

    const worktreeDisplay = this.worktreeDir
      ? getDisplayWorktreePath(this.repoCwd, this.worktreeDir)
      : null;

    return {
      ok: true,
      worktreePath: worktreeDisplay ?? undefined,
    };
  }

  /**
   * Resume an existing session from JSONL.
   * Detects existing worktree and reconstructs state from the log.
   */
  async resume(opts: { cwd: string; sessionId?: string }): Promise<{
    ok: boolean;
    error?: string;
    runCount?: number;
  }> {
    this.repoCwd = opts.cwd;
    this.sessionId = opts.sessionId ?? "";

    // Detect existing worktree
    if (opts.sessionId) {
      const wt = detectWorktree(this.repoCwd, opts.sessionId);
      if (wt) {
        this.worktreeDir = wt;
        this.workDir = wt;
      }
    }

    this.workDir = this.workDir || this.repoCwd;
    this.jsonlPath = path.join(this.workDir, "autoresearch.jsonl");

    if (!fs.existsSync(this.jsonlPath)) {
      return { ok: false, error: "No autoresearch.jsonl found — nothing to resume" };
    }

    // Reconstruct state from JSONL
    const entries = readEntries(this.jsonlPath);
    this.state = reconstructState(entries);

    return {
      ok: true,
      runCount: this.state.results.length,
    };
  }

  // -----------------------------------------------------------------------
  // Running Experiments
  // -----------------------------------------------------------------------

  /**
   * Run the benchmark command. Times it, captures output, detects pass/fail.
   * Does NOT log the result — call log() separately, or use runAndLog().
   */
  async run(opts: { timeoutSeconds?: number } = {}): Promise<RunDetails> {
    const config = this.state.config;
    if (!config) {
      return makeErrorRunDetails(
        "Session not initialized — call init() first",
        this.state.metricName,
        this.state.metricUnit,
      );
    }

    // Check max runs
    if (this.state.maxRuns !== null && this.state.results.length >= this.state.maxRuns) {
      return makeErrorRunDetails(
        `Maximum runs reached (${this.state.maxRuns})`,
        this.state.metricName,
        this.state.metricUnit,
      );
    }

    const runDetails = await executeRun({
      cwd: this.workDir,
      config,
      metricName: this.state.metricName,
      metricUnit: this.state.metricUnit,
      timeoutSeconds: opts.timeoutSeconds,
      checksTimeoutSeconds: config.checksTimeoutSeconds,
    });

    // Track temp files for cleanup
    if (runDetails.fullOutputPath) this.tempFiles.add(runDetails.fullOutputPath);

    // Store last run details for the log() checks gate
    this.lastRunDetails = runDetails;

    return runDetails;
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  /**
   * Log an experiment result. Auto-commits on keep, auto-reverts on discard.
   */
  async log(opts: {
    metric: number;
    status: ExperimentStatus;
    description: string;
    metrics?: Record<string, number>;
    asi?: Record<string, unknown>;
    durationSeconds?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    autoCommitted?: boolean;
    autoReverted?: boolean;
    commit?: string;
    confidence?: number | null;
    improvement?: string | null;
    targetReached?: boolean;
  }> {
    if (!this.jsonlPath) {
      return { ok: false, error: "No JSONL log path — call init() first" };
    }

    if (!this.state.config) {
      return { ok: false, error: "Session not initialized — call init() first" };
    }

    // Cannot keep when checks failed (mirrors pi-autoresearch's runtime.lastRunChecks gate)
    if (opts.status === "keep" && this.lastRunChecksFailed()) {
      return {
        ok: false,
        error:
          "Cannot keep — checks failed. Log as 'checks_failed' instead.\n\n" +
          (this.lastRunDetails?.checksOutput?.slice(-500) ?? ""),
      };
    }

    const commit = getHeadCommit(this.workDir);
    const secondaryMetrics = opts.metrics ?? {};

    // Register secondary metrics (use shared inferUnit from parse.ts)
    this.state.secondaryMetrics = registerSecondaryMetrics(
      this.state.secondaryMetrics,
      secondaryMetrics,
      inferUnit,
    );

    // Build experiment result
    const experiment: ExperimentResult = {
      run: this.state.results.length + 1,
      commit,
      metric: opts.metric,
      metrics: secondaryMetrics,
      status: opts.status,
      description: opts.description,
      timestamp: Date.now(),
      segment: this.state.currentSegment,
      confidence: null,
      durationSeconds: opts.durationSeconds ?? 0,
      asi: opts.asi,
    };

    this.state.results.push(experiment);

    // Recalculate derived state
    // Baseline = first result in the current segment (matching pi-autoresearch)
    const currentSegmentResults = this.state.results.filter(
      (r) => r.segment === this.state.currentSegment,
    );
    this.state.baselineMetric = currentSegmentResults[0]?.metric ?? null;
    this.state.confidence = computeConfidence(this.state.results, this.state.direction);

    // Set confidence on the result before persisting
    experiment.confidence = this.state.confidence;

    // Update best metric (across all kept results in current segment)
    let best: number | null = null;
    for (const r of currentSegmentResults) {
      if (r.status === "keep" && r.metric > 0) {
        if (best === null || isBetter(r.metric, best, this.state.direction)) {
          best = r.metric;
        }
      }
    }
    this.state.bestMetric = best;

    // Persist to JSONL
    const jsonlEntry: JsonlResultEntry = {
      type: "result",
      ...experiment,
    };
    writeJsonlResult(this.jsonlPath, jsonlEntry);

    // Auto-commit on keep
    let autoCommitted = false;
    let newCommit: string | undefined;
    if (opts.status === "keep") {
      const resultData: Record<string, unknown> = {
        status: opts.status,
        [this.state.metricName || "metric"]: opts.metric,
        ...secondaryMetrics,
      };
      const commitMsg = `${opts.description}\n\nResult: ${JSON.stringify(resultData)}`;
      const commitHash = commitChanges(this.workDir, commitMsg);
      if (commitHash) {
        autoCommitted = true;
        newCommit = commitHash;
        experiment.commit = commitHash;
      }
    }

    // Auto-revert on discard/crash/checks_failed/timeout/metric_error/no_op/hook_blocked
    let autoReverted = false;
    if (opts.status !== "keep") {
      autoReverted = revertChanges(this.workDir);
    }

    // Check target reached
    const targetReached =
      opts.status === "keep" &&
      this.state.targetValue !== null &&
      opts.metric > 0 &&
      (this.state.direction === "lower"
        ? opts.metric <= this.state.targetValue
        : opts.metric >= this.state.targetValue);

    // Build improvement string (direction-aware: positive = improvement)
    const improvement = formatImprovement(
      opts.metric,
      this.state.baselineMetric ?? 0,
      this.state.direction,
    );

    return {
      ok: true,
      autoCommitted,
      autoReverted,
      commit: newCommit,
      confidence: this.state.confidence,
      improvement,
      targetReached,
    };
  }

  // -----------------------------------------------------------------------
  // Combined Run + Log
  // -----------------------------------------------------------------------

  /**
   * Run an experiment and log the result in one call.
   * Uses the strategy to decide keep/discard.
   */
  async runAndLog(opts: {
    timeoutSeconds?: number;
    description?: string;
    asi?: Record<string, unknown>;
  } = {}): Promise<{
    ok: boolean;
    error?: string;
    result?: ExperimentResult;
    logResult?: Awaited<ReturnType<Session["log"]>>;
  }> {
    // Run the experiment
    const runResult = await this.run({ timeoutSeconds: opts.timeoutSeconds });

    // Handle spawn failure (not timeout — that's a proper experiment result)
    if (!runResult.passed && !runResult.timedOut && runResult.exitCode === null) {
      return { ok: false, error: runResult.tailOutput };
    }

    // Determine status
    let status: ExperimentStatus;
    if (runResult.timedOut) {
      status = "timeout";
    } else if (!runResult.passed) {
      if (runResult.checksPass === false) {
        status = "checks_failed";
      } else {
        status = "crash";
      }
    } else {
      // Passed — use strategy to decide
      const metric = runResult.parsedPrimary ?? 0;
      if (metric > 0 && this.state.baselineMetric !== null) {
        // Create a tentative result for strategy evaluation
        const tentativeResult: ExperimentResult = {
          run: this.state.results.length + 1,
          commit: getHeadCommit(this.workDir),
          metric,
          metrics: runResult.parsedMetrics ?? {},
          status: "keep",
          description: opts.description ?? "",
          timestamp: Date.now(),
          segment: this.state.currentSegment,
          confidence: this.state.confidence,
          durationSeconds: runResult.durationSeconds,
        };

        const decision = this.strategy.evaluate(tentativeResult, this.state);
        switch (decision) {
          case "keep":
            status = "keep";
            break;
          case "discard":
            status = "discard";
            break;
          case "rework":
            // Improvement is marginal (below confidence threshold).
            // Log as no_op so the result is tracked but code is reverted,
            // signaling that a re-run would be beneficial.
            status = "no_op";
            break;
          default:
            status = "discard";
        }
      } else {
        // First run or no parsed metric — always keep as baseline
        status = "keep";
      }
    }

    // Log the result
    const metric = runResult.parsedPrimary ?? 0;
    const logResult = await this.log({
      metric,
      status,
      description: opts.description ?? (status === "keep" ? "experiment" : status),
      metrics: runResult.parsedMetrics ?? {},
      asi: opts.asi,
      durationSeconds: runResult.durationSeconds,
    });

    return {
      ok: true,
      logResult,
    };
  }

  // -----------------------------------------------------------------------
  // Loop
  // -----------------------------------------------------------------------

  /**
   * Start an autonomous loop. The harness detects file changes,
   * runs the benchmark, and applies the strategy automatically.
   */
  startLoop(opts: LoopOptions = {}): { ok: boolean; loopId?: string; error?: string } {
    // Apply the loop's strategy to the session if specified
    // (so runAndLog uses it; restored on stop)
    if (opts.strategy) {
      this.strategy = createStrategy(opts.strategy);
    }

    const result = this.loop.start(this, opts);
    if (!result.ok && opts.strategy) {
      // Restore default strategy on failure
      this.strategy = createStrategy();
    }
    return result;
  }

  /** Stop the autonomous loop. */
  stopLoop(): { ok: boolean } {
    const result = this.loop.stop();

    // Restore default strategy if loop had overridden it
    if (this.loop["options"]?.strategy) {
      this.strategy = createStrategy();
    }

    return result;
  }

  /** Get current loop status. */
  getLoopStatus(): LoopStatus {
    return this.loop.getStatus();
  }

  // -----------------------------------------------------------------------
  // Status & Querying
  // -----------------------------------------------------------------------

  /** Get current session status. */
  status(): {
    initialized: boolean;
    name: string | null;
    runs: number;
    kept: number;
    discarded: number;
    bestMetric: number | null;
    baselineMetric: number | null;
    improvement: string | null;
    confidence: number | null;
    targetValue: number | null;
    targetReached: boolean;
    loopStatus: LoopStatus;
    worktree: string | null;
  } {
    const kept = this.state.results.filter((r) => r.status === "keep").length;
    const discarded = this.state.results.filter((r) => r.status !== "keep" && r.status !== "baseline").length;

    const improvement = formatImprovement(
      this.state.bestMetric ?? 0,
      this.state.baselineMetric ?? 0,
      this.state.direction,
    );

    return {
      initialized: this.state.config !== null,
      name: this.state.config?.name ?? null,
      runs: this.state.results.length,
      kept,
      discarded,
      bestMetric: this.state.bestMetric,
      baselineMetric: this.state.baselineMetric,
      improvement,
      confidence: this.state.confidence,
      targetValue: this.state.targetValue,
      targetReached: this.isTargetReached(),
      loopStatus: this.getLoopStatus(),
      worktree: this.worktreeDir,
    };
  }

  /** Get recent results. */
  results(opts: { last?: number } = {}): ExperimentResult[] {
    const results = this.state.results;
    if (opts.last) {
      return results.slice(-opts.last);
    }
    return [...results];
  }

  /** Clear session state and clean up resources. */
  clear(): { ok: boolean } {
    this.loop.stop();

    if (this.worktreeDir) {
      removeWorktree(this.repoCwd, this.worktreeDir);
      this.worktreeDir = null;
    }

    if (this.jsonlPath) {
      deleteLog(this.jsonlPath);
    }

    // Clean up temp files
    for (const f of this.tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.tempFiles.clear();

    this.state = this.createInitialState();
    this.lastRunDetails = null;
    this.workDir = this.repoCwd;
    this.jsonlPath = "";

    return { ok: true };
  }

  /** Set the guard configuration. */
  setGuard(config: GuardConfig): { ok: boolean } {
    this.state.guard = config;
    return { ok: true };
  }

  /** Set the strategy. */
  setStrategy(config: StrategyName | StrategyConfig): { ok: boolean } {
    this.strategy = createStrategy(config);
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  /**
   * Check whether the last run's checks failed.
   * Mirrors pi-autoresearch's runtime.lastRunChecks gate.
   */
  private lastRunChecksFailed(): boolean {
    if (!this.lastRunDetails) return false;
    return this.lastRunDetails.checksPass === false;
  }

  /** Check if the target value has been reached. */
  private isTargetReached(): boolean {
    if (this.state.targetValue === null || this.state.bestMetric === null) return false;
    return this.state.direction === "lower"
      ? this.state.bestMetric <= this.state.targetValue
      : this.state.bestMetric >= this.state.targetValue;
  }
}
