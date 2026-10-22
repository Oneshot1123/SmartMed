"""Train, calibrate and export the SmartMed dose-risk model.

Production model: logistic regression on scaled features (interpretable).
Training order:
  1. Fit coefficients on simulated pretraining rows (temporal holdout).
  2. Calibrate the intercept against real pilot events (prior correction).
  3. Evaluate on a real temporal holdout and, optionally, leave-one-patient-out.

Exports dashboard/ml-model.js so the browser performs inference with no server.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

from features import FEATURES, dataset_feature_rows
from forecast import fit_series

BASE = Path(__file__).parent
SIM_PATH = BASE / "data" / "simulated.json"
REAL_PATH = BASE / "data" / "real_data.json"
MODEL_PATH = BASE / "models" / "risk_model.json"
JS_PATH = BASE.parent / "dashboard" / "ml-model.js"
CARD_PATH = BASE / "model_card.md"
VERSION = "1.0.0"
SEED = 27
THRESHOLD = 0.5
# Below this many usable real rows, an intercept correction is noise, not calibration.
MIN_REAL_CALIBRATION_ROWS = 20


def load_dataset(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def rows_to_matrix(rows: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    x = np.array([[row["features"][name] for name in FEATURES] for row in rows], dtype=float)
    y = np.array([row["label"] for row in rows], dtype=int)
    return x, y


def measure(y_true: np.ndarray, y_pred: np.ndarray, y_prob: np.ndarray | None = None) -> dict:
    result = {
        "n": int(len(y_true)),
        "positive_rate": float(np.mean(y_true)) if len(y_true) else None,
        "accuracy": float(accuracy_score(y_true, y_pred)) if len(y_true) else None,
        "confusion": None,
    }
    if len(y_true):
        tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
        result["confusion"] = {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}
    if len(set(y_true.tolist())) > 1:
        result["precision"] = float(precision_score(y_true, y_pred, zero_division=0))
        result["recall"] = float(recall_score(y_true, y_pred, zero_division=0))
        result["f1"] = float(f1_score(y_true, y_pred, zero_division=0))
        if y_prob is not None:
            result["roc_auc"] = float(roc_auc_score(y_true, y_prob))
            result["brier"] = float(brier_score_loss(y_true, y_prob))
    else:
        result["precision"] = None
        result["recall"] = None
        result["f1"] = None
        result["roc_auc"] = None
        if y_prob is not None:
            result["brier"] = float(brier_score_loss(y_true, y_prob))
    return result


def temporal_split(rows: list[dict], test_fraction: float = 0.2) -> tuple[list[dict], list[dict]]:
    dates = sorted({row["date"] for row in rows})
    test_count = max(7, int(round(len(dates) * test_fraction)))
    test_dates = set(dates[-test_count:])
    train = [row for row in rows if row["date"] not in test_dates]
    test = [row for row in rows if row["date"] in test_dates]
    if not train or not test:
        return rows, rows
    return train, test


def _safe_logit(rate: float) -> float:
    rate = min(max(rate, 1e-4), 1 - 1e-4)
    return math.log(rate / (1 - rate))


def calibrate_intercept(base_intercept: float, probabilities: np.ndarray, labels: np.ndarray) -> tuple[float, dict]:
    misses = int(np.sum(labels))
    total = int(len(labels))
    smoothed_rate = (misses + 1) / (total + 2) if total else 0.05
    mean_probability = float(np.mean(probabilities)) if total else smoothed_rate
    mean_probability = min(max(mean_probability, 1e-4), 1 - 1e-4)
    delta = _safe_logit(smoothed_rate) - _safe_logit(mean_probability)
    return base_intercept + delta, {
        "method": "intercept_prior_correction",
        "calibration_rows": total,
        "observed_rate": (misses / total) if total else None,
        "calibrated_rate": smoothed_rate,
        "intercept_delta": delta,
    }


def real_metrics(rows: list[dict], scaler: StandardScaler, coefficients: np.ndarray,
                 intercept: float) -> tuple[dict | None, np.ndarray | None, np.ndarray | None]:
    if not rows:
        return None, None, None
    rows = sorted(rows, key=lambda row: (row["date"], row["minutes"]))
    x, y = rows_to_matrix(rows)
    probability = 1 / (1 + np.exp(-((x - scaler.mean_) / scaler.scale_ @ coefficients + intercept)))
    prediction = (probability >= THRESHOLD).astype(int)
    metrics = measure(y, prediction, probability)
    metrics["patients"] = len({row["patient_id"] for row in rows})
    metrics["events"] = len(rows)
    metrics["base_rate"] = float(np.mean(y)) if len(y) else None
    return metrics, y, probability


def leave_one_patient_out(rows: list[dict], scaler: StandardScaler, coefficients: np.ndarray,
                          intercept: float) -> dict | None:
    patients = sorted({row["patient_id"] for row in rows})
    if len(patients) < 3:
        return None
    all_labels = []
    all_probabilities = []
    folds = []
    for patient in patients:
        train = [row for row in rows if row["patient_id"] != patient]
        test = [row for row in rows if row["patient_id"] == patient]
        if len(test) < 5 or not train:
            continue
        xt, yt = rows_to_matrix(train)
        probabilities_train = 1 / (1 + np.exp(-((xt - scaler.mean_) / scaler.scale_ @ coefficients + intercept)))
        fold_intercept, _ = calibrate_intercept(intercept, probabilities_train, yt)
        xe, ye = rows_to_matrix(test)
        probabilities_test = 1 / (1 + np.exp(-((xe - scaler.mean_) / scaler.scale_ @ coefficients + fold_intercept)))
        all_labels.extend(ye.tolist())
        all_probabilities.extend(probabilities_test.tolist())
        folds.append({"patient": patient, "rows": int(len(test))})
    if not all_labels:
        return None
    labels = np.array(all_labels)
    probabilities = np.array(all_probabilities)
    prediction = (probabilities >= THRESHOLD).astype(int)
    result = measure(labels, prediction, probabilities)
    result["folds"] = folds
    if len(set(labels.tolist())) < 2:
        result["note"] = "single-class real outcomes; AUC unavailable"
    return result


def build_daily_series(rows: list[dict]) -> list[float]:
    by_date: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        by_date[row["date"]].append(row["label"])
    return [100.0 * (1 - statistics.mean(by_date[key])) for key in sorted(by_date)]


def write_js(model: dict) -> None:
    payload = json.dumps(model, indent=2)
    JS_PATH.write_text(
        "(function (global) {\n"
        "  var MODEL = " + payload + ";\n"
        "  if (typeof module !== 'undefined' && module.exports) module.exports = MODEL;\n"
        "  global.SmedMLModel = MODEL;\n"
        "})(typeof window !== 'undefined' ? window : globalThis);\n",
        encoding="utf-8",
    )


def format_table(rows: list[list[str]], headers: list[str]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return "\n".join(lines)


def write_model_card(model: dict, benchmark: list[dict], calibration: dict | None) -> None:
    metrics = model["metrics"]["simulated_holdout"]
    real = model["metrics"].get("real")
    forecast = model["forecast"]
    benchmark_table = format_table(
        [
            [
                item["model"],
                f"{item['metrics']['accuracy']:.3f}" if item["metrics"]["accuracy"] is not None else "--",
                f"{item['metrics']['roc_auc']:.3f}" if item["metrics"].get("roc_auc") is not None else "--",
                f"{item['metrics']['precision']:.3f}" if item["metrics"].get("precision") is not None else "--",
                f"{item['metrics']['recall']:.3f}" if item["metrics"].get("recall") is not None else "--",
            ]
            for item in benchmark
        ],
        ["Model", "Accuracy", "AUC", "Precision", "Recall"],
    )
    real_table = "No real pilot rows available at export time."
    if model["data_sources"]["real_rows"]:
        real_table = (
            f"{model['data_sources']['real_rows']} usable real dose rows from "
            f"{model['data_sources']['real_patients']} patient(s) — below the "
            f"{MIN_REAL_CALIBRATION_ROWS}-row minimum for calibration and evaluation."
        )
    if real:
        real_table = format_table(
            [
                ["Events", real.get("events", real.get("n"))],
                ["Patients", real.get("patients", "--")],
                ["Observed non-adherence rate", f"{real.get('base_rate'):.3f}" if real.get("base_rate") is not None else "--"],
                ["Accuracy", f"{real['accuracy']:.3f}" if real.get("accuracy") is not None else "--"],
                ["AUC", f"{real['roc_auc']:.3f}" if real.get("roc_auc") is not None else "-- (single class)"],
                ["Brier score", f"{real['brier']:.3f}" if real.get("brier") is not None else "--"],
            ],
            ["Metric", "Value"],
        )
    real_calibration = (calibration or {}).get("real")
    simulated_calibration = (calibration or {}).get("simulated_holdout") or {}
    calibration_text = (
        f"Simulated holdout intercept correction: observed rate "
        f"{simulated_calibration.get('observed_rate', 0):.3f}. "
    )
    if real_calibration:
        calibration_text += (
            f"Real-data prior correction on {real_calibration['calibration_rows']} rows; "
            f"observed non-adherence rate {real_calibration['observed_rate']:.3f}."
        )
    elif model["data_sources"]["real_rows"]:
        calibration_text += (
            f"Real pilot has {model['data_sources']['real_rows']} usable rows, below the "
            f"{MIN_REAL_CALIBRATION_ROWS}-row minimum; the simulated prior was retained."
        )
    else:
        calibration_text += "No real rows were available for a real-data correction."
    holdout_text = "not available"
    if forecast.get("holdout"):
        holdout_text = (
            f"MAE {forecast['holdout']['mae']:.2f} pp vs naive {forecast['holdout']['naive_mae']:.2f} pp"
        )
    card = f"""# SmartMed ML Model Card

**Version:** {model['version']}  ·  **Trained:** {model['trained_at']}  ·  **Model:** logistic regression

## Purpose
Predict the probability that an upcoming scheduled dose will be **missed or taken more than
60 minutes late** (a non-adherent dose). Predictions are per-dose, made from strictly past
history, and surfaced to the caregiver as a ranked risk list.

## Data sources
| Source | Labelled doses | Patients |
|---|---|---|
| Simulated pretraining | {model['data_sources']['simulated_rows']} | {model['data_sources']['simulated_patients']} |
| Real pilot rows | {model['data_sources']['real_rows']} | {model['data_sources']['real_patients']} |

Simulated events encode weekend effects, evening drift, long delays and occasional drug
holidays. They are used to fit the feature weights. Real rows are used only for
calibration and evaluation — never to fabricate the headline metrics.

## Features ({len(FEATURES)})
{', '.join(FEATURES)}

Cyclical hour and weekday encodings, weekend flag, compartment, within-day slot index,
7/14/30-day rolling taking adherence, current non-adherence streak, median lateness over
the prior 7 days, days since the last missed/late dose, this slot's 14-day miss rate, this
weekday's 28-day miss rate, the previous dose's outcome, and the usual delay for this slot.
All history features use days **strictly before** the target dose, so there is no leakage.

## Target
`non_adherent = missed OR |actual - scheduled| > 60 minutes`

This aligns the target with the timing-adherence definition in `dashboard/analytics.js`
and keeps enough positive cases in a small real pilot. It is broader than "missed only",
which is stated explicitly here to avoid overclaiming.

## Held-out performance (simulated, temporal split)
| Metric | Value |
|---|---|
| Accuracy | {metrics['accuracy']:.3f} |
| ROC-AUC | {metrics['roc_auc']:.3f} |
| Precision | {metrics['precision']:.3f} |
| Recall | {metrics['recall']:.3f} |
| Brier | {metrics['brier']:.3f} |
| Events | {metrics['n']} |

## Benchmark (simulated temporal holdout)
{benchmark_table}

Logistic regression is the production model because its coefficients can be explained to a
clinician and it is stable on small real samples. Tree ensembles are benchmarked for
due diligence only.

## Real pilot calibration and evaluation
{real_table}

{calibration_text}

## 7-day adherence forecast
Damped Holt linear-trend exponential smoothing, alpha={forecast['alpha']:.2f},
beta={forecast['beta']:.2f}, phi={forecast['phi']:.2f}.
Rolling-origin backtest (4 x 7-day folds): {holdout_text}. The dashboard applies the frozen
parameters to the patient's real daily series, so the trend and level always reflect live data.

## Limitations
- The real pilot is short; metrics have wide confidence intervals and are reported as
  indicative. AUC is omitted when only one outcome class was observed.
- Simulated behavioural patterns are a prior, not evidence of real-world accuracy.
- Single-centre, small voluntary sample; volunteers may show novelty/white-coat adherence.
- Sensor-only adherence cannot verify ingestion.
- The dashboard pauses risk scores after 3 days without a dose event while doses were due.
  A silent device is not proof of non-adherence; it may be off, disconnected, or unused.

## Retraining
Set `SMARTMED_EMAIL` and `SMARTMED_PASSWORD` in the environment first (never commit them):
```
python ml/fetch_firebase.py
python ml/train_risk.py --sim ml/data/simulated.json --real ml/data/real_data.json
```
The second command rewrites `ml/models/risk_model.json`, `dashboard/ml-model.js` and this
model card. Inference is static JavaScript; no server or redeploy step is required beyond
refreshing the dashboard.
"""
    CARD_PATH.write_text(card, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sim", type=Path, default=SIM_PATH)
    parser.add_argument("--real", type=Path, default=REAL_PATH)
    parser.add_argument("--loso", action="store_true")
    args = parser.parse_args()

    sim_data = load_dataset(args.sim)
    if not sim_data:
        raise SystemExit(f"Simulated dataset not found: {args.sim}. Run ml/data_gen.py first.")

    yield_vars = dataset_feature_rows(sim_data, keep_simulated=True)
    if not yield_vars:
        raise SystemExit("Simulated dataset produced no feature rows.")

    train_rows, test_rows = temporal_split(yield_vars)
    xtr, ytr = rows_to_matrix(train_rows)
    xte, yte = rows_to_matrix(test_rows)

    scaler = StandardScaler().fit(xtr)
    xtr_scaled = scaler.transform(xtr)
    xte_scaled = scaler.transform(xte)

    logistic = LogisticRegression(C=1.0, class_weight="balanced", max_iter=2000, random_state=SEED)
    logistic.fit(xtr_scaled, ytr)
    coefficients = logistic.coef_[0].copy()
    intercept = float(logistic.intercept_[0])

    simulated_probabilities = logistic.predict_proba(xte_scaled)[:, 1]
    intercept, simulated_calibration = calibrate_intercept(intercept, simulated_probabilities, yte)
    calibrated_probabilities = 1 / (1 + np.exp(-(xte_scaled @ coefficients + intercept)))
    logistic_metrics = measure(
        yte,
        (calibrated_probabilities >= THRESHOLD).astype(int),
        calibrated_probabilities,
    )

    random_forest = RandomForestClassifier(
        n_estimators=200, max_depth=6, class_weight="balanced_subsample",
        n_jobs=-1, random_state=SEED,
    )
    random_forest.fit(xtr, ytr)
    rf_metrics = measure(yte, random_forest.predict(xte), random_forest.predict_proba(xte)[:, 1])

    gradient_boosting = GradientBoostingClassifier(n_estimators=150, max_depth=3, random_state=SEED)
    gradient_boosting.fit(xtr, ytr)
    gb_metrics = measure(yte, gradient_boosting.predict(xte), gradient_boosting.predict_proba(xte)[:, 1])

    benchmark = [
        {"model": "Logistic regression (production)", "metrics": logistic_metrics},
        {"model": "Random forest", "metrics": rf_metrics},
        {"model": "Gradient boosting", "metrics": gb_metrics},
    ]

    calibration = {"simulated_holdout": simulated_calibration, "real": None}

    real_data = load_dataset(args.real)
    real_rows = dataset_feature_rows(real_data) if real_data else []
    if real_rows:
        yesterday = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
        real_rows = [row for row in real_rows if row["date"] <= yesterday]
    real_patients = len({row["patient_id"] for row in real_rows})
    real_metrics_payload = None
    real_loso = None

    if len(real_rows) >= MIN_REAL_CALIBRATION_ROWS:
        real_rows.sort(key=lambda row: (row["date"], row["minutes"]))
        calibration_count = max(1, int(round(len(real_rows) * 0.7)))
        calibration_rows = real_rows[:calibration_count]
        evaluation_rows = real_rows[calibration_count:]

        xc, yc = rows_to_matrix(calibration_rows)
        xc_scaled = scaler.transform(xc)
        probabilities_calibration = 1 / (1 + np.exp(-(xc_scaled @ coefficients + intercept)))
        intercept, real_calibration = calibrate_intercept(intercept, probabilities_calibration, yc)
        calibration["real"] = real_calibration

        evaluation_pool = evaluation_rows if len(evaluation_rows) >= 5 else real_rows
        xr, yr = rows_to_matrix(evaluation_pool)
        xr_scaled = scaler.transform(xr)
        probabilities_real = 1 / (1 + np.exp(-(xr_scaled @ coefficients + intercept)))
        predictions_real = (probabilities_real >= THRESHOLD).astype(int)
        real_metrics_payload = measure(yr, predictions_real, probabilities_real)
        real_metrics_payload["patients"] = len({row["patient_id"] for row in evaluation_pool})
        real_metrics_payload["events"] = len(evaluation_pool)
        real_metrics_payload["base_rate"] = float(np.mean(yr))
        real_metrics_payload["is_holdout"] = len(evaluation_rows) >= 5
        if not real_metrics_payload["is_holdout"]:
            real_metrics_payload["note"] = "too few real rows for a holdout; calibration-sample metrics"

        if args.loso:
            real_loso = leave_one_patient_out(real_rows, scaler, coefficients, intercept)

    forecast_series = build_daily_series(yield_vars)
    forecast = fit_series(forecast_series, horizon=7)
    forecast["source"] = "simulated daily taking series"

    model = {
        "version": VERSION,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "model": "logistic_regression",
        "target": "non_adherent_dose",
        "target_definition": "missed OR |actual - scheduled| > 60 minutes",
        "features": FEATURES,
        "scaler": {
            "mean": [float(v) for v in scaler.mean_],
            "scale": [float(v) for v in scaler.scale_],
        },
        "coefficients": [float(v) for v in coefficients],
        "intercept": float(intercept),
        "thresholds": {"high": 0.6, "medium": 0.3},
        "metrics": {
            "simulated_holdout": logistic_metrics,
            "benchmark": {item["model"]: item["metrics"] for item in benchmark},
            "real": real_metrics_payload,
            "real_loso": real_loso,
        },
        "calibration": calibration,
        "data_sources": {
            "simulated_rows": len(yield_vars),
            "simulated_patients": len(sim_data.get("patients", {})),
            "real_rows": len(real_rows),
            "real_patients": real_patients,
        },
        "forecast": forecast,
    }

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    MODEL_PATH.write_text(json.dumps(model, indent=2), encoding="utf-8")
    write_js(model)
    write_model_card(model, benchmark, calibration)

    print(f"Simulated rows: {len(yield_vars)} (train {len(train_rows)}, test {len(test_rows)})")
    print(f"Logistic  accuracy={logistic_metrics['accuracy']:.3f} auc={logistic_metrics['roc_auc']:.3f}")
    print(f"RF        accuracy={rf_metrics['accuracy']:.3f} auc={rf_metrics['roc_auc']:.3f}")
    print(f"GBM       accuracy={gb_metrics['accuracy']:.3f} auc={gb_metrics['roc_auc']:.3f}")
    print(f"Real rows: {len(real_rows)} from {real_patients} patient(s)")
    if real_metrics_payload:
        print(
            "Real eval accuracy="
            f"{real_metrics_payload['accuracy']:.3f} "
            f"base_rate={real_metrics_payload['base_rate']:.3f}"
        )
    print(f"Forecast: alpha={forecast['alpha']:.2f} beta={forecast['beta']:.2f}")
    print(f"Wrote {MODEL_PATH}")
    print(f"Wrote {JS_PATH}")
    print(f"Wrote {CARD_PATH}")


if __name__ == "__main__":
    main()
