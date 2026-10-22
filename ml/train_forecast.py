"""Standalone CLI for fitting the Holt forecast parameters."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean

from features import dataset_feature_rows
from forecast import fit_series

BASE = Path(__file__).parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=BASE / "data" / "simulated.json")
    parser.add_argument("--out", type=Path, default=BASE / "models" / "forecast_params.json")
    parser.add_argument("--horizon", type=int, default=7)
    args = parser.parse_args()

    dataset = json.loads(args.data.read_text(encoding="utf-8"))
    rows = dataset_feature_rows(dataset)
    by_date: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        by_date[row["date"]].append(row["label"])

    series = [100.0 * (1 - mean(by_date[key])) for key in sorted(by_date)]
    fitted = fit_series(series, args.horizon)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(fitted, indent=2), encoding="utf-8")
    print(json.dumps(fitted, indent=2))
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
