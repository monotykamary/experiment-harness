/**
 * experiment-harness SDK — public API.
 *
 * Re-exports all modules for convenient consumption.
 */

// Types
export type {
  SessionConfig,
  ExperimentStatus,
  ExperimentResult,
  StrategyName,
  StrategyConfig,
  StrategyDecision,
  LoopOptions,
  LoopStatus,
  RunDetails,
  MetricDef,
  SessionState,
  JsonlConfigEntry,
  JsonlResultEntry,
  JsonlEntry,
} from "./types.ts";
export { DENIED_METRIC_NAMES, METRIC_LINE_PREFIX } from "./types.ts";

// Parse
export { parseMetricLines, inferUnit, isAutoresearchShCommand } from "./parse.ts";

// Format
export { commas, fmtNum, formatNum, formatElapsed, formatSize } from "./format.ts";

// Stats
export {
  isImprovement,
  formatImprovement,
  sortedMedian,
  isBetter,
  computeConfidence,
  detectPlateau,
  registerSecondaryMetrics,
} from "./stats.ts";

// Strategy
export {
  createStrategy,
  GreedyStrategy,
  ConfidenceGatedStrategy,
  EpsilonGreedyStrategy,
  type Strategy,
  type RandomSource,
} from "./strategy.ts";

// Log
export {
  reconstructState,
  writeConfig,
  writeResult,
  readEntries,
  deleteLog,
} from "./log.ts";

// Git
export {
  git,
  gitSafe,
  getHeadCommit,
  createWorktree,
  removeWorktree,
  commitChanges,
  revertChanges,
  getDisplayWorktreePath,
  detectWorktree,
  getProtectedFiles,
} from "./git.ts";

// Session
export { Session } from "./session/index.ts";

// Session internals (for advanced use / testing)
export { spawnProcess, killTree, createTempFileAllocator } from "./session/process.ts";
export { executeRun, makeErrorRunDetails } from "./session/run.ts";
export { LoopController, detectFileChanges } from "./session/loop.ts";
