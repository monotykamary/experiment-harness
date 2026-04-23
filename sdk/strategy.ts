/**
 * Strategy — keep/discard decision logic for experiment results.
 *
 * The strategy is invoked after each experiment run to decide
 * whether to keep or discard the change. This replaces the
 * LLM-based keep/discard decision from pi-autoresearch.
 */

import type { StrategyName, StrategyDecision, StrategyConfig, ExperimentResult, SessionState } from "./types.ts";
import { isBetter } from "./stats.ts";

// ---------------------------------------------------------------------------
// Strategy Interface
// ---------------------------------------------------------------------------

export interface Strategy {
  evaluate(result: ExperimentResult, state: SessionState): StrategyDecision;
}

/** Random source interface for deterministic testing. */
export interface RandomSource {
  random(): number;
}

/** Default random source using Math.random. */
const defaultRandom: RandomSource = { random: () => Math.random() };

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * Greedy: improved → keep, worse/equal → discard.
 * Simple, fast, no confirmation step.
 */
export class GreedyStrategy implements Strategy {
  evaluate(result: ExperimentResult, state: SessionState): StrategyDecision {
    // Crashes, timeouts, etc. are always discarded
    if (result.status !== "keep") return "discard";

    // First result ever — always keep (it's the baseline)
    if (state.baselineMetric === null) return "keep";

    // Check if primary metric improved
    if (isBetter(result.metric, state.baselineMetric!, state.direction)) {
      return "keep";
    }

    return "discard";
  }
}

/**
 * Confidence-gated: only keep if the improvement is statistically
 * significant (confidence ≥ threshold). Otherwise, rework (re-run to confirm).
 */
export class ConfidenceGatedStrategy implements Strategy {
  constructor(private minConfidence: number = 1.5) {}

  evaluate(result: ExperimentResult, state: SessionState): StrategyDecision {
    if (result.status !== "keep") return "discard";
    if (state.baselineMetric === null) return "keep";

    if (!isBetter(result.metric, state.baselineMetric!, state.direction)) {
      return "discard";
    }

    // If we don't have enough data for confidence, keep optimistically
    if (state.confidence === null) return "keep";

    // If confidence is above threshold, keep
    if (state.confidence >= this.minConfidence) return "keep";

    // Below threshold — suggest rework (re-run to confirm)
    return "rework";
  }
}

/**
 * Epsilon-greedy: mostly greedy, but with probability epsilon
 * keeps marginal improvements for exploration.
 * Accepts an injectable random source for deterministic testing.
 */
export class EpsilonGreedyStrategy implements Strategy {
  private rng: RandomSource;

  constructor(epsilon: number = 0.1, rng?: RandomSource) {
    this.rng = rng ?? defaultRandom;
    // Capture epsilon at construction time for consistency
    this.epsilon = epsilon;
  }

  private epsilon: number;

  evaluate(result: ExperimentResult, state: SessionState): StrategyDecision {
    if (result.status !== "keep") return "discard";
    if (state.baselineMetric === null) return "keep";

    if (isBetter(result.metric, state.baselineMetric!, state.direction)) {
      return "keep";
    }

    // With probability epsilon, keep marginal/no-change results (exploration)
    if (this.rng.random() < this.epsilon) return "keep";

    return "discard";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a strategy from a config or name. */
export function createStrategy(config?: StrategyName | StrategyConfig): Strategy {
  if (!config) return new GreedyStrategy();

  if (typeof config === "string") {
    switch (config) {
      case "greedy":
        return new GreedyStrategy();
      case "confidence-gated":
        return new ConfidenceGatedStrategy();
      case "epsilon-greedy":
        return new EpsilonGreedyStrategy();
      default:
        return new GreedyStrategy();
    }
  }

  switch (config.name) {
    case "confidence-gated":
      return new ConfidenceGatedStrategy(config.minConfidence);
    case "epsilon-greedy":
      return new EpsilonGreedyStrategy(config.epsilon);
    case "greedy":
    default:
      return new GreedyStrategy();
  }
}
