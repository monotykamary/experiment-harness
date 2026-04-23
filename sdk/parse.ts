/**
 * Metric parsing — extract structured METRIC lines from command output.
 */

import { METRIC_LINE_PREFIX, DENIED_METRIC_NAMES } from "./types.ts";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Returns a Map preserving insertion order of first occurrence per key.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(
    `^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`,
    "gm",
  );
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

/** Infer unit from metric name suffix. */
export function inferUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

/**
 * Check if a command's primary purpose is running autoresearch.sh.
 *
 * Strips common harmless prefixes (env vars, wrappers) then checks
 * that the core command is autoresearch.sh invoked via a known pattern.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers repeatedly
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(
      /^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/,
      "",
    );
  } while (cmd !== prev);

  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(
    cmd,
  );
}
