# experiment-harness

**Autonomous experiment loop as a skill + embedded binary.**

A long-lived Bun HTTP server holding a persistent `Session` that runs experiment loops as code — not as prompt instructions. The `experiment-harness-js` CLI auto-starts the server and forwards JS snippets to it. Any agent that can run `bash` can use it.

_Try an idea, measure it, keep what works, discard what doesn't, repeat forever._

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch), [browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js), and [pi-autoresearch](https://github.com/monotykamary/pi-autoresearch).

---

## Why this exists

Existing autoresearch tools have the LLM run the loop. Every `run_experiment` → `log_experiment` round-trip costs tokens, adds latency, and the LLM can invoke experiment tools unprompted. The loop protocol lives in prompt instructions — soft guidelines the LLM can ignore.

**experiment-harness runs the loop as code.** The harness handles timing, output parsing, git commit/revert, confidence scoring, and keep/discard decisions. The agent proposes code changes; the harness tests them.

| Problem | pi-autoresearch | uditgoenka/autoresearch | experiment-harness |
|---|---|---|---|
| LLM runs tools unprompted | ✗ tools always registered | ✗ LLM can ignore instructions | ✓ No tools — just `bash` + CLI |
| Loop costs tokens | ✗ ~2K tokens/iteration | ✗ same | ✓ Loop runs in code, free |
| Loop is slow | ✗ ~5s LLM round-trip | ✗ same | ✓ ~0.1s per iteration |
| Protocol not enforced | ✗ soft guidelines | ✗ all prompt, no enforcement | ✓ Keep/discard is code |
| Agent-agnostic | ✗ pi-specific | Mostly Claude | ✓ Any agent with `bash` |
| Git isolation | ✓ worktrees | ✗ no isolation | ✓ worktrees |
| Confidence scoring | ✓ MAD-based | ✗ none | ✓ MAD-based + strategy-gated |

---

## Quick Start

### 1. Install

```bash
# Clone
git clone https://github.com/monotykamary/experiment-harness.git

# Symlink CLI to PATH
ln -sf $(pwd)/experiment-harness/sdk/experiment-harness-js /usr/local/bin/experiment-harness-js
```

### 2. Initialize a session

```bash
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Optimize test speed",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    command: "bash autoresearch.sh",
    targetValue: 30
  }
})'
```

### 3. Write autoresearch.sh

```bash
#!/bin/bash
set -euo pipefail
START=$(date +%s%N)
pnpm test --run 2>&1
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "METRIC seconds=$(echo "scale=1; $ELAPSED_MS / 1000" | bc)"
```

### 4. Run experiments

```bash
# Single run + log
experiment-harness-js 'await session.runAndLog()'

# Or start an autonomous loop
experiment-harness-js 'await session.startLoop({ maxRuns: 50, strategy: "confidence-gated" })'

# Check progress
experiment-harness-js 'session.status()'

# The harness monitors for file changes and re-runs the benchmark automatically
# Just make code changes with your normal edit tools
```

### 5. When done

```bash
# Stop the loop
experiment-harness-js 'session.stopLoop()'

# Get results
experiment-harness-js 'session.results()'

# Or clear everything
experiment-harness-js 'session.clear()'
```

---

## How it Works

### Architecture

```
┌──────────────────────────────────────────────────┐
│  experiment-harness-js (Bun HTTP server)         │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Session  │  │ Strategy │  │ Loop Runner    │  │
│  │ (state)  │  │ (decide) │  │ (file watch →  │  │
│  │          │  │          │  │  run → decide) │  │
│  └─────┬────┘  └────┬─────┘  └──────┬─────────┘  │
│        │            │               │            │
│        ▼            ▼               ▼            │
│  ┌──────────┐  ┌─────────┐  ┌───────────────┐    │
│  │ JSONL    │  │ Git     │  │ Parse         │    │
│  │ (log)    │  │ (commit │  │ (METRIC lines)│    │
│  │          │  │  revert)│  │               │    │
│  └──────────┘  └─────────┘  └───────────────┘    │
└──────────────────────────────────────────────────┘
     ▲
     │ bash: experiment-harness-js '<JS>'
     │
┌────┴─────┐
│   Agent  │  (any agent: pi, Claude Code, Codex, Aider, Cursor, …)
│          │  proposes code changes → harness tests them
└──────────┘
```

### The Loop

```
WHILE not stopped:
  1. Detect file changes (or manual trigger)
  2. Run benchmark command → capture output + METRIC lines
  3. Run backpressure checks (if autoresearch.checks.sh exists)
  4. Apply strategy → decide keep / discard / rework
  5. Auto-commit on keep, auto-revert on discard
  6. Log result to autoresearch.jsonl
  7. Check stopping conditions (target, plateau, max runs)
```

### Session API

| Method | Description |
|--------|-------------|
| `session.init(opts)` | Initialize session — creates worktree, writes config |
| `session.resume(opts)` | Resume from existing JSONL log |
| `session.run(opts)` | Run benchmark — returns timing, output, parsed metrics |
| `session.log(opts)` | Log result — auto-commits/reverts |
| `session.runAndLog(opts)` | Run + log in one shot — uses strategy |
| `session.startLoop(opts)` | Start autonomous loop |
| `session.stopLoop()` | Stop the loop |
| `session.status()` | Current session status |
| `session.results(opts)` | Get result history |
| `session.setGuard(config)` | Set backpressure guard |
| `session.setStrategy(config)` | Set keep/discard strategy |
| `session.clear()` | Reset all state, remove worktree |

### Strategies

| Strategy | Behavior | When to Use |
|----------|----------|-------------|
| `greedy` | Improved → keep, worse → discard | Deterministic metrics, no noise |
| `confidence-gated` | Only keep if confidence ≥ threshold | Noisy metrics (benchmarks, Lighthouse) |
| `epsilon-greedy` | Like greedy + random exploration | When you want to explore aggressively |

### Confidence Scoring

After 3+ runs, the harness computes a confidence score using Median Absolute Deviation (MAD):

| Confidence | Meaning |
|---|---|
| ≥ 2.0× | Improvement is likely real |
| 1.0–2.0× | Above noise but marginal |
| < 1.0× | Within noise — consider re-running |

---

## Structured Output: METRIC Lines

Your benchmark script should output `METRIC name=value` lines:

```bash
echo "METRIC total_µs=12300"
echo "METRIC compile_µs=4200"
echo "METRIC render_µs=8100"
```

The harness parses these automatically. The primary metric (matching `metricName` from init) drives keep/discard. Secondary metrics are tracked for trade-off monitoring.

---

## Git Worktree Isolation

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

Benefits:
- Main working directory stays clean
- Side commits accumulate in the worktree
- Easy to merge back successful changes or discard everything
- `autoresearch/` is auto-added to your global gitignore

---

## Files

| Path | Purpose |
|------|---------|
| `sdk/server.ts` | Bun HTTP server — holds Session, handles /eval |
| `sdk/session.ts` | Session class — init, run, log, loop |
| `sdk/git.ts` | Git worktree management, commit/revert |
| `sdk/strategy.ts` | Keep/discard strategies (greedy, confidence-gated, etc.) |
| `sdk/parse.ts` | METRIC line parsing, command validation |
| `sdk/stats.ts` | Confidence scoring, MAD, plateau detection |
| `sdk/log.ts` | JSONL append/read, state reconstruction |
| `sdk/format.ts` | Number/time/size formatting |
| `sdk/types.ts` | Core type definitions |
| `sdk/experiment-harness-js` | Bash CLI |
| `SKILL.md` | Agent-agnostic skill file |
| `interaction-skills/` | Domain-specific guides |

---

## Comparison with pi-autoresearch

[pi-autoresearch](https://github.com/monotykamary/pi-autoresearch) is a pi extension that registers tools (`init_experiment`, `run_experiment`, `log_experiment`), injects system prompts, and uses pi's TUI API for dashboards. It works well but has inherent limitations:

- The LLM is the loop controller — every iteration costs tokens and time
- Tools are always registered — the LLM can invoke them unprompted
- Keep/discard is a prompt instruction — soft, not enforced
- Tightly coupled to pi's extension API

experiment-harness extracts the core loop logic into a standalone binary. pi-autoresearch can become a thin integration layer (TUI widget, keyboard shortcuts) that delegates to the harness via CLI calls.

---

## License

MIT
