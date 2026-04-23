/**
 * Autonomous loop controller — extracted from Session.
 *
 * Manages the file-change-detection → run → log → plateau-check cycle.
 * Accepts a LoopHost interface so it has no direct dependency on Session.
 */

import { execFileSync } from "node:child_process";
import type {
  LoopOptions,
  LoopStatus,
  ExperimentResult,
} from "../types.ts";
import { detectPlateau } from "../stats.ts";

// ---------------------------------------------------------------------------
// Host interface (implemented by Session)
// ---------------------------------------------------------------------------

/** Narrow interface the loop needs from its host. */
export interface LoopHost {
  /** Run one experiment + log cycle. */
  runAndLog(opts: {
    timeoutSeconds?: number;
    description?: string;
  }): Promise<{ ok: boolean; error?: string; result?: ExperimentResult; logResult?: any }>;

  /** Current session status. */
  status(): {
    initialized: boolean;
    runs: number;
    targetReached: boolean;
    loopStatus: LoopStatus;
    bestMetric: number | null;
    targetValue: number | null;
  };

  /** Get current results. */
  results(opts?: { last?: number }): ExperimentResult[];

  /** Current direction. */
  readonly direction: "lower" | "higher";

  /** Current max runs. */
  readonly maxRuns: number | null;

  /** Update loop status. */
  setLoopStatus(status: LoopStatus): void;
}

// ---------------------------------------------------------------------------
// Loop Controller
// ---------------------------------------------------------------------------

export class LoopController {
  private status: LoopStatus = "idle";
  private options: LoopOptions | null = null;
  private abort: AbortController | null = null;

  /** Get current loop status. */
  getStatus(): LoopStatus {
    return this.status;
  }

  /** Start the autonomous loop. */
  start(
    host: LoopHost,
    opts: LoopOptions = {},
  ): { ok: boolean; loopId?: string; error?: string } {
    if (!host.status().initialized) {
      return { ok: false, error: "Session not initialized — call init() first" };
    }

    if (this.status === "running") {
      return { ok: false, error: "Loop already running" };
    }

    this.options = opts;
    this.abort = new AbortController();
    this.status = "running";
    host.setLoopStatus("running");

    const loopId = `loop-${Date.now()}`;

    // Run the loop in the background (non-blocking)
    this.runLoop(host, opts, this.abort.signal).catch((e) => {
      console.error(`Loop error: ${e}`);
      this.status = "stopped";
      host.setLoopStatus("stopped");
    });

    return { ok: true, loopId };
  }

  /** Stop the autonomous loop. */
  stop(): { ok: boolean } {
    if (this.abort) {
      this.abort.abort();
    }
    this.status = "stopped";
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async runLoop(
    host: LoopHost,
    opts: LoopOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const pollInterval = (opts.pollIntervalSeconds ?? 2) * 1000;
    const plateauPatience = opts.plateauPatience ?? 15;

    while (!signal.aborted) {
      // Check stopping conditions
      if (host.maxRuns !== null && host.results().length >= host.maxRuns) {
        this.status = "completed";
        host.setLoopStatus("completed");
        return;
      }

      // Check target reached
      const st = host.status();
      if (opts.stopOnTarget !== false && st.targetReached) {
        this.status = "completed";
        host.setLoopStatus("completed");
        return;
      }

      // Check plateau
      const plateau = detectPlateau(
        host.results(),
        host.direction,
        plateauPatience,
      );
      if (plateau.plateaued) {
        this.status = "paused";
        host.setLoopStatus("paused");
        return;
      }

      // Detect file changes since last run (including untracked files)
      const changes = detectFileChanges(
        // We need the workDir; the host must expose it
        (host as any).workDir ?? "",
      );
      if (changes.length === 0) {
        await Bun.sleep(pollInterval);
        continue;
      }

      // Run the experiment
      const result = await host.runAndLog({
        description: `auto-run #${host.results().length + 1}`,
      });

      if (!result.ok) {
        await Bun.sleep(pollInterval);
        continue;
      }

      await Bun.sleep(500); // Small delay between runs
    }
  }
}

// ---------------------------------------------------------------------------
// File change detection
// ---------------------------------------------------------------------------

/**
 * Detect file changes in a directory since last run (tracked and untracked).
 * Uses git diff + git ls-files to find modified and new files.
 */
export function detectFileChanges(workDir: string): string[] {
  try {
    // Tracked changes
    const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // Untracked files (not yet added to git)
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: workDir,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "ignore"],
      },
    ).trim();

    const all = (tracked + "\n" + untracked).split("\n").filter(Boolean);
    return [...new Set(all)]; // deduplicate
  } catch {
    return [];
  }
}
