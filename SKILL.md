---
name: experiment-harness
description: Autonomous experiment loop driven by `experiment-harness-js` CLI. Init a session, run benchmarks, log results, or start an autonomous loop that detects file changes and decides keep/discard automatically. Use when asked to optimize a metric, run experiments, start autoresearch, or iterate on improvements autonomously. Works with any agent that can run bash commands.
---

# Experiment Harness

A long-lived Bun HTTP server holding a persistent `Session`. The `experiment-harness-js` CLI auto-starts the server on first use and forwards JS snippets to it. Session state, results, and globals survive across calls.

The harness **runs the experiment loop as code** — not as prompt instructions. It handles timing, output parsing, git commit/revert, confidence scoring, and keep/discard decisions. The agent proposes code changes; the harness tests them.

## Setup (once, first use)

The CLI should be on PATH. Symlink it if not:

```bash
# macOS (Apple Silicon + Homebrew)
command -v experiment-harness-js >/dev/null || ln -sf <skill-dir>/sdk/experiment-harness-js /opt/homebrew/bin/experiment-harness-js

# macOS (Intel) / most Linux — may need sudo
command -v experiment-harness-js >/dev/null || ln -sf <skill-dir>/sdk/experiment-harness-js /usr/local/bin/experiment-harness-js

# Linux without sudo (ensure ~/.local/bin is on PATH)
command -v experiment-harness-js >/dev/null || { mkdir -p ~/.local/bin && ln -sf <skill-dir>/sdk/experiment-harness-js ~/.local/bin/experiment-harness-js; }
```

The CLI auto-installs `bun` on first run if it's missing. Set `EXPERIMENT_HARNESS_SKIP_BUN_INSTALL=1` to opt out.

## How to use

Just run `experiment-harness-js '<JS>'`. The first call spawns the server; subsequent calls reuse the same session.

```bash
experiment-harness-js 'await session.init({ cwd: "/path/to/project", config: { name: "optimize tests", metricName: "seconds", direction: "lower", command: "bash autoresearch.sh" } })'
experiment-harness-js 'await session.run()'
experiment-harness-js 'await session.log({ metric: 12.3, status: "keep", description: "pool workers" })'
experiment-harness-js 'session.status()'
```

Output is the raw result — no `{ok,result}` envelope. Strings print bare, objects print as JSON. Errors go to stderr with exit code 1.

**Multi-line snippets via stdin (heredoc).** Write `return X` explicitly for multi-statement snippets. Single-expression snippets auto-return.

## CLI commands

| Command | Behavior |
|---|---|
| `experiment-harness-js '<js>'` | Auto-start server if needed, eval the JS, print result |
| `experiment-harness-js <<EOF…EOF` | Same, code from stdin |
| `experiment-harness-js --status` | Print health JSON or exit 1 if down |
| `experiment-harness-js --start` | Explicit start (no-op if already running) |
| `experiment-harness-js --stop` | Graceful shutdown. Drops session state |
| `experiment-harness-js --restart` | Stop + start fresh |
| `experiment-harness-js --logs` | `tail -f` the server log |

Env vars: `EXPERIMENT_HARNESS_PORT` (default `9877`), `EXPERIMENT_HARNESS_LOG` (default `/tmp/experiment-harness.log`).

## API surface inside snippets

These globals are pre-loaded — no imports needed:

- `session` — the persistent `Session`. All methods below are on this object.

## Session Lifecycle

### 1. Initialize a session

```bash
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Optimize test speed",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    command: "bash autoresearch.sh",
    targetValue: 30,
    maxRuns: 100
  }
})'
# → { ok: true, worktreePath: "autoresearch/session-1700000000" }
```

This creates:
- A git worktree at `autoresearch/<session-id>/` (keeps your main directory clean)
- A `autoresearch.jsonl` log (append-only source of truth)
- An `autoresearch/` entry in your global gitignore

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `cwd` | Yes | Absolute path to the project root |
| `config.name` | Yes | Human-readable session name |
| `config.metricName` | Yes | Display name for the primary metric (e.g. "total_µs") |
| `config.metricUnit` | No | Unit suffix (e.g. "µs", "ms", "s", "kb") |
| `config.direction` | Yes | `"lower"` or `"higher"` — which is better |
| `config.command` | Yes | Shell command to run for each experiment |
| `config.targetValue` | No | Stop when metric reaches this threshold |
| `config.maxRuns` | No | Maximum number of runs |
| `sessionId` | No | Custom session ID (default: auto-generated) |
| `worktree` | No | Create git worktree for isolation (default: true) |

### 2. Resume an existing session

```bash
experiment-harness-js 'await session.resume({ cwd: "/path/to/project", sessionId: "session-1700000000" })'
# → { ok: true, runCount: 23 }
```

Reconstructs state from `autoresearch.jsonl` — survives restarts and context resets.

### 3. Run an experiment

```bash
experiment-harness-js 'await session.run({ timeoutSeconds: 600 })'
# → { command: "bash autoresearch.sh", exitCode: 0, durationSeconds: 12.3, passed: true,
#     parsedMetrics: { total_µs: 12300, compile_µs: 4200 }, parsedPrimary: 12.3, ... }
```

Runs the command, times it, captures output, parses `METRIC name=value` lines. Does NOT log the result — call `log()` separately.

### 4. Log a result

```bash
experiment-harness-js 'await session.log({
  metric: 12.3,
  status: "keep",
  description: "pool vitest workers",
  metrics: { compile_µs: 4200, render_µs: 8100 },
  asi: { hypothesis: "pooling reduces overhead", rollback_reason: null }
})'
# → { ok: true, autoCommitted: true, commit: "a1b2c3d", confidence: "3.2×", improvement: "-18.2%" }
```

Auto-commits on `keep`. Auto-reverts on `discard`/`crash`/`checks_failed`. Preserves autoresearch files during revert.

**Status values:** `keep`, `discard`, `crash`, `checks_failed`, `timeout`, `metric_error`

### 5. Run + Log in one shot

```bash
experiment-harness-js 'await session.runAndLog()'
# → { ok: true, logResult: { ... } }
```

Runs the benchmark and logs the result. Uses the configured strategy to decide keep/discard automatically.

### 6. Start an autonomous loop

```bash
experiment-harness-js 'await session.startLoop({
  maxRuns: 50,
  strategy: "confidence-gated",
  plateauPatience: 15,
  pollIntervalSeconds: 2
})'
# → { ok: true, loopId: "loop-1700000000" }
```

The harness now monitors for file changes. When it detects changes, it:
1. Runs the benchmark
2. Applies the strategy to decide keep/discard
3. Auto-commits or auto-reverts
4. Checks stopping conditions (target reached, plateau, max runs)

**You just make code changes with your normal edit tools — the harness tests them automatically.**

### 7. Check status

```bash
experiment-harness-js 'session.status()'
# → { initialized: true, name: "optimize tests", runs: 23, kept: 8,
#     bestMetric: 11.2, baselineMetric: 15.1, improvement: "-25.8%",
#     confidence: 4.1, targetValue: 30, targetReached: true,
#     loopStatus: "completed", worktree: "/path/autoresearch/session-1700000000" }
```

### 8. Get results

```bash
experiment-harness-js 'session.results({ last: 5 })'
# → [ { run: 19, metric: 11.8, status: "keep", ... }, ... ]
```

### 9. Set strategy

```bash
experiment-harness-js 'await session.setStrategy("confidence-gated")'
experiment-harness-js 'await session.setStrategy({ name: "confidence-gated", minConfidence: 2.0 })'
experiment-harness-js 'await session.setStrategy("greedy")'
experiment-harness-js 'await session.setStrategy({ name: "epsilon-greedy", epsilon: 0.15 })'
```

**Strategy options:**

| Strategy | Behavior |
|---|---|
| `greedy` | Improved → keep, worse → discard. Simple, fast. |
| `confidence-gated` | Only keep if confidence ≥ threshold (default 1.5×). Below → rework. |
| `epsilon-greedy` | Like greedy, but with probability ε keeps marginal results for exploration. |

### 11. Stop loop / Clear session

```bash
experiment-harness-js 'session.stopLoop()'
experiment-harness-js 'session.clear()'
```

`clear()` removes the worktree, deletes the JSONL log, and resets all state.

## Structured Output: Metric Lines

Your benchmark script should output `METRIC name=value` lines to stdout. The harness parses them automatically.

```bash
#!/bin/bash
set -euo pipefail
# autoresearch.sh
time pnpm test --run 2>&1
echo "METRIC total_µs=12300"
echo "METRIC compile_µs=4200"
echo "METRIC render_µs=8100"
```

## Worktree Pattern

Each session creates a git worktree at `autoresearch/<session-id>/`:

```
project/
├── src/                         # Your main code (stays clean)
├── autoresearch/
│   └── <session-id>/           # Isolated worktree for experiments
│       ├── autoresearch.md     # Session document
│       ├── autoresearch.sh     # Benchmark script
│       ├── autoresearch.jsonl  # Results log (source of truth)
│       └── ...
└── ...
```

## Confidence Scoring

After 3+ runs, the harness computes a confidence score (best improvement / MAD noise floor):

| Confidence | Meaning |
|---|---|
| ≥ 2.0× | Improvement is likely real |
| 1.0–2.0× | Above noise but marginal |
| < 1.0× | Within noise — consider re-running |

## The autoresearch.sh Script

Write this script in the worktree before running experiments. It should:
1. Pre-check fast (syntax errors in <1s)
2. Run the benchmark
3. Output `METRIC name=value` lines

For fast/noisy benchmarks (<5s), run the workload multiple times and report the median.

## autoresearch.md

Write this in the worktree. A fresh agent should be able to read it and resume:

```markdown
# Autoresearch: <goal>

## Objective
<What we're optimizing>

## Metrics
- Primary: <name> (<unit>, lower/higher is better)
- Target: <value or "none">

## How to Run
`./autoresearch.sh`

## Files in Scope
<Files the agent may modify>

## What's Been Tried
<Update as experiments accumulate>
```

## When to Use

Use experiment-harness when:
- You want to optimize a measurable metric (test speed, bundle size, accuracy, etc.)
- You want the loop to run autonomously without burning LLM tokens on every iteration
- You want keep/discard decisions based on code, not prompt instructions
- You want git isolation so failed experiments don't pollute your main directory

Don't use when:
- Quick one-shot fixes that don't need iteration
- No measurable metric exists
- You need subjective evaluation (use the agent directly)

## Guardrails

- Autoresearch is ONLY for optimization tasks with verifiable metrics
- Be careful not to overfit to the benchmark
- Do not cheat on the benchmark

## Example Domains

| Domain | Metric | Command |
|---|---|---|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| ML training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse ... --output=json` |
| Test coverage | % ↑ | `npx jest --coverage` |
