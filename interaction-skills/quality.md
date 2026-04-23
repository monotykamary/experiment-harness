# Quality — Test Coverage, Lint Errors, Type Safety

## When to Use

Improving code quality metrics: test coverage, lint error count, type errors, etc.

## Setup Pattern

```bash
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Increase test coverage to 90%",
    metricName: "coverage_pct",
    metricUnit: "%",
    direction: "higher",
    command: "bash autoresearch.sh",
    targetValue: 90
  }
})'
```

## Writing autoresearch.sh

```bash
#!/bin/bash
set -euo pipefail

# Run tests with coverage
npx jest --coverage 2>&1 | tee /tmp/coverage_output.txt

# Extract coverage percentage
COVERAGE=$(grep 'All files' /tmp/coverage_output.txt | awk '{print $4}')

echo "METRIC coverage_pct=$COVERAGE"
```

## Tips

- Coverage is deterministic — `greedy` strategy works well
- Set a guard to prevent type errors: `session.setGuard({ command: "tsc --noEmit", mode: "pass-fail" })`
- Report secondary metrics: test count, assertion count
- Coverage targets are great for bounded runs — set `maxRuns` to control cost
