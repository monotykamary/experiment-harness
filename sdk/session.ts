/**
 * Session — the core experiment session object.
 *
 * Holds all state for a single experiment session: config, results,
 * worktree, guard, strategy. Persists to JSONL. Reconstructs from JSONL.
 * Provides the API that the server exposes via /eval.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import type {
  SessionConfig,
  SessionState,
  ExperimentResult,
  ExperimentStatus,
  RunDetails,
  GuardConfig,
  StrategyConfig,
  StrategyDecision,
  LoopOptions,
  LoopStatus,
  JsonlConfigEntry,
  JsonlResultEntry,
} from "./types.ts";
import { parseMetricLines, isAutoresearchShCommand } from "./parse.ts";
import { formatNum } from "./format.ts";
import { isBetter, computeConfidence, detectPlateau, registerSecondaryMetrics } from "./stats.ts";
import { reconstructState, writeConfig as writeJsonlConfig, writeResult as writeJsonlResult, readEntries, deleteLog } from "./log.ts";
import {
  createWorktree,
  removeWorktree,
  commitChanges,
  revertChanges,
  getHeadCommit,
  detectWorktree,
  getDisplayWorktreePath,
} from "./git.ts";
import { createStrategy, type Strategy } from "./strategy.ts";
import type { StrategyName } from "./types.ts";

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/** Kill a process tree (best effort). */
function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

/** Lazy temp file allocator. */
function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = Math.random().toString(36).slice(2, 18);
      p = path.join(import.meta.dir || "/tmp", `experiment-${id}.log`);
    }
    return p;
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  // Project root (where the git repo lives)
  private repoCwd: string = "";
  // Working directory (worktree if active, otherwise repoCwd)
  private workDir: string = "";
  // Worktree path (null if not using worktree isolation)
  private worktreeDir: string | null = null;

  // JSONL log path (resolved after workDir is set)
  private jsonlPath: string = "";

  // Session state (source of truth is the JSONL, this is the in-memory mirror)
  private state: SessionState;

  // Strategy for keep/discard decisions
  private strategy: Strategy;

  // Loop state
  private loopStatus: LoopStatus = "idle";
  private loopOptions: LoopOptions | null = null;
  private loopAbort: AbortController | null = null;

  // Session ID (used for worktree naming)
  private sessionId: string = "";

  constructor() {
    this.state = this.createInitialState();
    this.strategy = createStrategy();
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
      return this.makeErrorRunDetails("Session not initialized — call init() first");
    }

    // Guard: if autoresearch.sh exists, only allow running it
    const autoresearchShPath = path.join(this.workDir, "autoresearch.sh");
    if (
      fs.existsSync(autoresearchShPath) &&
      !isAutoresearchShCommand(config.command)
    ) {
      return this.makeErrorRunDetails(
        `autoresearch.sh exists — you must run it instead of a custom command.`,
      );
    }

    // Check max runs
    if (this.state.maxRuns !== null && this.state.results.length >= this.state.maxRuns) {
      return this.makeErrorRunDetails(
        `Maximum runs reached (${this.state.maxRuns})`,
      );
    }

    const timeout = (opts.timeoutSeconds ?? 600) * 1000;
    const t0 = Date.now();

    // Capture starting commit BEFORE running
    const startingCommit = getHeadCommit(this.workDir);

    // Spawn the process
    const getTempFile = createTempFileAllocator();
    const {
      exitCode,
      killed: timedOut,
      output,
      tempFilePath: streamTempFile,
      actualTotalBytes,
    } = await this.spawnProcess(config.command, timeout);

    const durationSeconds = (Date.now() - t0) / 1000;
    const benchmarkPassed = exitCode === 0 && !timedOut;

    // Run backpressure checks if benchmark passed and checks file exists
    let checksPass: boolean | null = null;
    let checksTimedOut = false;
    let checksOutput = "";
    let checksDuration = 0;

    const checksPath = path.join(this.workDir, "autoresearch.checks.sh");
    if (benchmarkPassed && fs.existsSync(checksPath)) {
      const checksTimeout = (config.checksTimeoutSeconds ?? 300) * 1000;
      const ct0 = Date.now();
      try {
        const checksResult = await this.spawnProcess(
          `bash ${checksPath}`,
          checksTimeout,
        );
        checksDuration = (Date.now() - ct0) / 1000;
        checksTimedOut = !!checksResult.killed;
        checksPass = checksResult.exitCode === 0 && !checksResult.killed;
        checksOutput = checksResult.output.trim();
      } catch (e) {
        checksDuration = (Date.now() - ct0) / 1000;
        checksPass = false;
        checksOutput = e instanceof Error ? e.message : String(e);
      }
    }

    const passed = benchmarkPassed && (checksPass === null || checksPass);

    // Max output for LLM context
    const maxLines = 10;
    const maxBytes = 4 * 1024;
    const lines = output.split("\n");
    const tailStart = Math.max(0, lines.length - maxLines);
    const tailOutput = lines.slice(tailStart).join("\n");

    // Parse structured METRIC lines
    const parsedMetricMap = parseMetricLines(output);
    const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
    const parsedPrimary = parsedMetricMap.get(this.state.metricName) ?? null;

    // Full output temp file for large outputs
    let fullOutputPath: string | undefined = streamTempFile;
    if (!fullOutputPath && (actualTotalBytes > maxBytes || lines.length > maxLines)) {
      fullOutputPath = getTempFile();
      fs.writeFileSync(fullOutputPath, output);
    }

    return {
      command: config.command,
      exitCode,
      durationSeconds,
      passed,
      crashed: !passed,
      timedOut,
      tailOutput,
      checksPass,
      checksTimedOut,
      checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
      checksDuration,
      parsedMetrics,
      parsedPrimary,
      metricName: this.state.metricName,
      metricUnit: this.state.metricUnit,
      fullOutputPath,
    };
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
    improvement?: string;
    targetReached?: boolean;
  }> {
    if (!this.jsonlPath) {
      return { ok: false, error: "No JSONL log path — call init() first" };
    }

    if (!this.state.config) {
      return { ok: false, error: "Session not initialized — call init() first" };
    }

    // Cannot keep when checks failed
    if (opts.status === "keep" && this.lastRunChecksFailed()) {
      return {
        ok: false,
        error: "Cannot keep — checks failed. Log as 'checks_failed' instead.",
      };
    }

    const commit = getHeadCommit(this.workDir);
    const secondaryMetrics = opts.metrics ?? {};

    // Register secondary metrics
    this.state.secondaryMetrics = registerSecondaryMetrics(
      this.state.secondaryMetrics,
      secondaryMetrics,
      (name: string) => {
        if (name.endsWith("µs")) return "µs";
        if (name.endsWith("_ms")) return "ms";
        if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
        if (name.endsWith("_kb")) return "kb";
        if (name.endsWith("_mb")) return "mb";
        return "";
      },
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
    this.state.baselineMetric = this.state.results[0]?.metric ?? null;
    this.state.confidence = computeConfidence(this.state.results, this.state.direction);

    // Set confidence on the result before persisting
    experiment.confidence = this.state.confidence;

    // Update best metric
    let best: number | null = null;
    for (const r of this.state.results) {
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

    // Auto-revert on discard/crash/checks_failed
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

    // Build improvement string
    let improvement: string | undefined;
    if (this.state.baselineMetric !== null && opts.metric > 0 && opts.metric !== this.state.baselineMetric) {
      const delta = opts.metric - this.state.baselineMetric;
      const pct = ((delta / this.state.baselineMetric) * 100).toFixed(1);
      const sign = delta > 0 ? "+" : "";
      improvement = `${sign}${pct}%`;
    }

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

    if (!runResult.passed && runResult.exitCode === null) {
      // Spawn failure
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
        if (decision === "discard") {
          status = "discard";
        } else {
          status = "keep";
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
    if (!this.state.config) {
      return { ok: false, error: "Session not initialized — call init() first" };
    }

    if (this.loopStatus === "running") {
      return { ok: false, error: "Loop already running" };
    }

    this.loopOptions = opts;
    this.loopAbort = new AbortController();
    this.loopStatus = "running";

    const loopId = `loop-${Date.now()}`;

    // Run the loop in the background (non-blocking)
    this.runLoop(opts, this.loopAbort.signal).catch((e) => {
      console.error(`Loop error: ${e}`);
      this.loopStatus = "stopped";
    });

    return { ok: true, loopId };
  }

  /** Stop the autonomous loop. */
  stopLoop(): { ok: boolean } {
    if (this.loopAbort) {
      this.loopAbort.abort();
    }
    this.loopStatus = "stopped";
    return { ok: true };
  }

  /** Get current loop status. */
  getLoopStatus(): LoopStatus {
    return this.loopStatus;
  }

  private async runLoop(opts: LoopOptions, signal: AbortSignal): Promise<void> {
    const pollInterval = (opts.pollIntervalSeconds ?? 2) * 1000;
    const plateauPatience = opts.plateauPatience ?? 15;
    const strategy = createStrategy(opts.strategy);
    let lastRunTime = 0;

    while (!signal.aborted) {
      // Check stopping conditions
      if (this.state.maxRuns !== null && this.state.results.length >= this.state.maxRuns) {
        this.loopStatus = "completed";
        return;
      }

      // Check target reached
      if (opts.stopOnTarget !== false && this.isTargetReached()) {
        this.loopStatus = "completed";
        return;
      }

      // Check plateau
      const plateau = detectPlateau(
        this.state.results,
        this.state.direction,
        plateauPatience,
      );
      if (plateau.plateaued) {
        this.loopStatus = "paused";
        return;
      }

      // Detect file changes since last run
      const changes = this.detectFileChanges();
      if (changes.length === 0) {
        await Bun.sleep(pollInterval);
        continue;
      }

      // Run the experiment
      const result = await this.runAndLog({
        description: `auto-run #${this.state.results.length + 1}`,
      });

      if (!result.ok) {
        // Wait before retrying
        await Bun.sleep(pollInterval);
        continue;
      }

      await Bun.sleep(500); // Small delay between runs
    }
  }

  /** Check if the target value has been reached. */
  private isTargetReached(): boolean {
    if (this.state.targetValue === null || this.state.bestMetric === null) return false;
    return this.state.direction === "lower"
      ? this.state.bestMetric <= this.state.targetValue
      : this.state.bestMetric >= this.state.targetValue;
  }

  /** Detect file changes in the worktree since last run. */
  private detectFileChanges(): string[] {
    try {
      const { execSync } = require("node:child_process");
      const result = execSync("git diff --name-only HEAD", {
        cwd: this.workDir,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (!result) return [];
      return result.split("\n").filter(Boolean);
    } catch {
      return [];
    }
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

    let improvement: string | null = null;
    if (
      this.state.bestMetric !== null &&
      this.state.baselineMetric !== null &&
      this.state.baselineMetric !== 0 &&
      this.state.bestMetric !== this.state.baselineMetric
    ) {
      const delta = this.state.bestMetric - this.state.baselineMetric;
      const pct = ((delta / this.state.baselineMetric) * 100).toFixed(1);
      const sign = delta > 0 ? "+" : "";
      improvement = `${sign}${pct}%`;
    }

    return {
      initialized: this.state.config !== null,
      name: this.state.config?.name ?? null,
      runs: this.state.results.length,
      kept,
      bestMetric: this.state.bestMetric,
      baselineMetric: this.state.baselineMetric,
      improvement,
      confidence: this.state.confidence,
      targetValue: this.state.targetValue,
      targetReached: this.isTargetReached(),
      loopStatus: this.loopStatus,
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

  /** Clear session state. */
  clear(): { ok: boolean } {
    if (this.loopAbort) {
      this.loopAbort.abort();
    }
    this.loopStatus = "idle";

    if (this.worktreeDir) {
      removeWorktree(this.repoCwd, this.worktreeDir);
      this.worktreeDir = null;
    }

    if (this.jsonlPath) {
      deleteLog(this.jsonlPath);
    }

    this.state = this.createInitialState();
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

  private async spawnProcess(
    command: string,
    timeout: number,
  ): Promise<{
    exitCode: number | null;
    killed: boolean;
    output: string;
    tempFilePath: string | undefined;
    actualTotalBytes: number;
  }> {
    return new Promise((resolve, reject) => {
      let processTimedOut = false;

      const child = spawn("bash", ["-c", command], {
        cwd: this.workDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let chunksBytes = 0;
      const maxChunksBytes = 100 * 1024; // 100KB rolling buffer

      let tempFilePath: string | undefined;
      let tempFileStream: ReturnType<typeof fs.createWriteStream> | undefined;
      let totalBytes = 0;

      const getTempFile = createTempFileAllocator();

      const handleData = (data: Buffer) => {
        totalBytes += data.length;

        if (totalBytes > 50000 && !tempFilePath) {
          tempFilePath = getTempFile();
          tempFileStream = fs.createWriteStream(tempFilePath);
          for (const chunk of chunks) {
            tempFileStream.write(chunk);
          }
        }

        if (tempFileStream) {
          tempFileStream.write(data);
        }

        chunks.push(data);
        chunksBytes += data.length;

        while (chunksBytes > maxChunksBytes && chunks.length > 1) {
          const removed = chunks.shift()!;
          chunksBytes -= removed.length;
        }
      };

      if (child.stdout) child.stdout.on("data", handleData);
      if (child.stderr) child.stderr.on("data", handleData);

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          processTimedOut = true;
          if (child.pid) killTree(child.pid);
        }, timeout);
      }

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (tempFileStream) tempFileStream.end();
        reject(err);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (tempFileStream) tempFileStream.end();

        const fullBuffer = Buffer.concat(chunks);
        resolve({
          exitCode: code,
          killed: processTimedOut,
          output: fullBuffer.toString("utf-8"),
          tempFilePath,
          actualTotalBytes: totalBytes,
        });
      });
    });
  }

  private makeErrorRunDetails(message: string): RunDetails {
    return {
      command: "",
      exitCode: null,
      durationSeconds: 0,
      passed: false,
      crashed: true,
      timedOut: false,
      tailOutput: message,
      checksPass: null,
      checksTimedOut: false,
      checksOutput: "",
      checksDuration: 0,
      parsedMetrics: null,
      parsedPrimary: null,
      metricName: this.state.metricName,
      metricUnit: this.state.metricUnit,
    };
  }

  private lastRunChecksFailed(): boolean {
    // This is a simple guard — in a fuller implementation we'd track
    // the last run's checks result in the session state.
    return false;
  }
}


