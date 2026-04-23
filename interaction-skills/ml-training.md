# ML Training — Loss, Accuracy, Training Speed

## When to Use

Optimizing ML model performance (loss, accuracy, training time) through iterative changes to model architecture, hyperparameters, or data pipeline.

## Setup Pattern

```bash
experiment-harness-js 'await session.init({
  cwd: "/path/to/project",
  config: {
    name: "Improve model accuracy",
    metricName: "val_accuracy",
    metricUnit: "",
    direction: "higher",
    command: "python train.py --eval-only",
    targetValue: 0.95
  }
})'
```

## Writing autoresearch.sh

```bash
#!/bin/bash
set -euo pipefail

# For long training runs
timeout 300 python train.py 2>&1 | tee /tmp/train_output.txt

# Extract metrics from training output
ACCURACY=$(grep 'val_accuracy' /tmp/train_output.txt | tail -1 | awk '{print $NF}')
LOSS=$(grep 'val_loss' /tmp/train_output.txt | tail -1 | awk '{print $NF}')

echo "METRIC val_accuracy=$ACCURACY"
echo "METRIC val_loss=$LOSS"
```

## Tips

- ML metrics are inherently noisy — use `confidence-gated` strategy with `minConfidence: 2.0`
- For large models, set a timeout and consider single-run evaluations
- Pin seeds for reproducibility: `PYTHONHASHSEED=42 python train.py --seed 42`
- Report secondary metrics (loss, training time) alongside the primary metric
- Use `epsilon-greedy` strategy if you want to explore more aggressively
- Set `maxRuns` to limit GPU time cost
