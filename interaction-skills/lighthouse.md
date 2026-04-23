# Lighthouse — Web Performance Scores

## When to Use

Optimizing Lighthouse performance, accessibility, or SEO scores.

## Setup Pattern

```bash
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Improve Lighthouse performance",
    metricName: "perf_score",
    metricUnit: "",
    direction: "higher",
    command: "bash autoresearch.sh",
    targetValue: 95
  }
})'
```

## Writing autoresearch.sh

```bash
#!/bin/bash
set -euo pipefail

# Build and start server
pnpm build
pnpm start &
SERVER_PID=$!
sleep 3

# Run Lighthouse
SCORE=$(npx lighthouse http://localhost:3000 --output=json --chrome-flags="--headless" 2>/dev/null | jq '.categories.performance.score * 100')

# Cleanup
kill $SERVER_PID 2>/dev/null || true

echo "METRIC perf_score=$SCORE"
```

## Tips

- Lighthouse scores are noisy — run 3-5 times and report the median
- Use `confidence-gated` strategy with `minConfidence: 2.0`
- Report secondary metrics: FCP, LCP, CLS, TTI
- Warm up the server before measuring
- Set `pollIntervalSeconds: 5` to allow server startup between runs
