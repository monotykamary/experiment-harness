# Optimization — Test Speed, Bundle Size, Build Time

## When to Use

Optimizing a measurable performance metric through iterative code changes. The metric must be mechanical — a command that outputs a number.

## Setup Pattern

```bash
# Initialize
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Optimize test runtime",
    metricName: "seconds",
    metricUnit: "s",
    direction: "lower",
    command: "bash autoresearch.sh",
    targetValue: 30
  }
})'

# Set a guard to prevent regressions
experiment-harness-js 'await session.setGuard({ command: "pnpm test --run", mode: "pass-fail" })'

# Start the autonomous loop
experiment-harness-js 'await session.startLoop({ strategy: "confidence-gated" })'
```

## Writing autoresearch.sh

For test speed optimization:

```bash
#!/bin/bash
set -euo pipefail

# Warm-up run (discard JIT/noise effects)
pnpm test --run 2>&1 >/dev/null

# Measured run
START=$(date +%s%N)
pnpm test --run 2>&1
END=$(date +%s%N)

ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "METRIC seconds=$(echo "scale=1; $ELAPSED_MS / 1000" | bc)"
```

For bundle size:

```bash
#!/bin/bash
set -euo pipefail
pnpm build 2>&1
SIZE=$(du -sb dist | awk '{print $1}')
echo "METRIC bundle_bytes=$SIZE"
```

## Tips

- For noisy benchmarks (<5s), run 3-5 times inside the script and report the median
- Always include a warm-up run before the measured run
- Set a guard command to prevent correctness regressions
- Use `confidence-gated` strategy for noisy metrics
- Watch the confidence score — if it's below 1.0×, your improvement may be noise
