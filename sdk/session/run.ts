/**
 * Experiment run execution — extracted from Session.run().
 *
 * Runs a benchmark command, captures output, runs backpressure checks,
 * parses METRIC lines, and returns a RunDetails object.
 * No dependency on Session state — all config is passed in.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { RunDetails, SessionConfig } from "../types.ts";
import { parseMetricLines, isAutoresearchShCommand } from "../parse.ts";
import {
  spawnProcess,
  createTempFileAllocator,
  type SpawnResult,
} from "./process.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteRunOptions {
  /** Working directory (worktree or repo cwd). */
  cwd: string;
  /** Session config. */
  config: SessionConfig;
  /** Primary metric name to extract from parsed metrics. */
  metricName: string;
  /** Unit string for the primary metric. */
  metricUnit: string;
  /** Timeout in seconds for the benchmark. Default: 600. */
  timeoutSeconds?: number;
  /** Timeout in seconds for the checks script. Default: 300. */
  checksTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Run a benchmark command with checks and metric parsing.
 * Returns a RunDetails object describing the outcome.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunDetails> {
  const { cwd, config, metricName, metricUnit } = opts;

  // Guard: if autoresearch.sh exists, only allow running it
  const autoresearchShPath = path.join(cwd, "autoresearch.sh");
  if (
    fs.existsSync(autoresearchShPath) &&
    !isAutoresearchShCommand(config.command)
  ) {
    return makeErrorRunDetails(
      `autoresearch.sh exists — you must run it instead of a custom command.`,
      metricName,
      metricUnit,
    );
  }

  const timeout = (opts.timeoutSeconds ?? 600) * 1000;
  const t0 = Date.now();
  const getTempFile = createTempFileAllocator();

  const {
    exitCode,
    killed: timedOut,
    output,
    tempFilePath: streamTempFile,
    actualTotalBytes,
  } = await spawnProcess({
    command: config.command,
    cwd,
    timeout,
    tempFileAllocator: getTempFile,
  });

  const durationSeconds = (Date.now() - t0) / 1000;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  // Run backpressure checks if benchmark passed and checks file exists
  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;

  const checksPath = path.join(cwd, "autoresearch.checks.sh");
  if (benchmarkPassed && fs.existsSync(checksPath)) {
    const checksTimeout = (opts.checksTimeoutSeconds ?? 300) * 1000;
    const ct0 = Date.now();
    try {
      const checksResult = await spawnProcess({
        command: `bash ${checksPath}`,
        cwd,
        timeout: checksTimeout,
        tempFileAllocator: getTempFile,
      });
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
  const parsedPrimary = parsedMetricMap.get(metricName) ?? null;

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
    metricName,
    metricUnit,
    fullOutputPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a RunDetails representing a pre-spawn error. */
export function makeErrorRunDetails(
  message: string,
  metricName: string,
  metricUnit: string,
): RunDetails {
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
    metricName,
    metricUnit,
  };
}
