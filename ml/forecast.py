"""Holt linear-trend exponential smoothing for the 7-day adherence forecast."""

from __future__ import annotations

import math
import statistics


def holt_forecast(series: list[float], alpha: float, beta: float, horizon: int = 7,
                  phi: float = 1.0) -> list[float]:
    if not series:
        return []
    if len(series) == 1:
        return [float(series[0])] * horizon

    level = float(series[0])
    trend = float(series[1]) - float(series[0])
    for index in range(1, len(series)):
        previous_level = level
        level = alpha * float(series[index]) + (1 - alpha) * (level + phi * trend)
        trend = beta * (level - previous_level) + (1 - beta) * phi * trend

    out = []
    damping = 0.0
    for step in range(1, horizon + 1):
        damping += phi ** step
        out.append(level + damping * trend)
    return out


def holt_fitted(series: list[float], alpha: float, beta: float,
                phi: float = 1.0) -> list[float]:
    if not series:
        return []
    fitted = [float(series[0])]
    if len(series) == 1:
        return fitted

    level = float(series[0])
    trend = float(series[1]) - float(series[0])
    for index in range(1, len(series)):
        fitted.append(level + phi * trend)
        previous_level = level
        level = alpha * float(series[index]) + (1 - alpha) * (level + phi * trend)
        trend = beta * (level - previous_level) + (1 - beta) * phi * trend
    return fitted


def fit_holt(series: list[float]) -> dict:
    if len(series) < 3:
        return {
            "alpha": 0.4,
            "beta": 0.1,
            "phi": 1.0,
            "in_sample_mae": None,
            "samples": len(series),
        }

    best = None
    for alpha_step in range(1, 20):
        alpha = alpha_step / 20.0
        for beta_step in range(0, 10):
            beta = beta_step / 20.0
            for phi in (0.80, 0.85, 0.90, 0.95, 1.0):
                fitted = holt_fitted(series, alpha, beta, phi)
                errors = [abs(fitted[i] - series[i]) for i in range(2, len(series))]
                mae = statistics.mean(errors) if errors else float("inf")
                if best is None or mae < best["in_sample_mae"]:
                    best = {
                        "alpha": alpha,
                        "beta": beta,
                        "phi": phi,
                        "in_sample_mae": float(mae),
                        "samples": len(series),
                    }
    return best


def _mape(actual: list[float], predicted: list[float]) -> float | None:
    pairs = [(a, p) for a, p in zip(actual, predicted) if abs(a) > 1e-9]
    if not pairs:
        return None
    return float(statistics.mean(abs((a - p) / a) * 100 for a, p in pairs))


def evaluate_holdout(series: list[float], horizon: int = 7, folds: int = 4) -> dict:
    """Rolling-origin backtest: repeatedly forecast the next 7 days from an earlier cut.

    A single 7-day holdout is too noisy to judge a smoother, so the error is averaged
    over four consecutive origins. Naive persistence (last value carried forward) is the
    benchmark every forecaster has to beat.
    """
    if len(series) < horizon * 2 + 7:
        params = fit_holt(series)
        return {
            "params": params,
            "holdout": None,
            "note": "series too short for a rolling-origin backtest",
        }

    errors = []
    naive_errors = []
    mapes = []
    folds_detail = []
    for fold in range(folds, 0, -1):
        cut = len(series) - horizon * fold
        if cut < 14:
            continue
        train = series[:cut]
        test = series[cut:cut + horizon]
        params = fit_holt(train)
        predicted = holt_forecast(train, params["alpha"], params["beta"], horizon, params["phi"])
        naive = [train[-1]] * horizon
        fold_mae = float(statistics.mean(abs(a - p) for a, p in zip(test, predicted)))
        fold_naive = float(statistics.mean(abs(a - n) for a, n in zip(test, naive)))
        errors.extend(abs(a - p) for a, p in zip(test, predicted))
        naive_errors.extend(abs(a - n) for a, n in zip(test, naive))
        fold_mape = _mape(test, predicted)
        if fold_mape is not None:
            mapes.append(fold_mape)
        folds_detail.append({
            "test_from": cut,
            "mae": fold_mae,
            "naive_mae": fold_naive,
        })

    holdout = None
    if errors:
        holdout = {
            "horizon": horizon,
            "folds": len(folds_detail),
            "mae": float(statistics.mean(errors)),
            "mape": float(statistics.mean(mapes)) if mapes else None,
            "naive_mae": float(statistics.mean(naive_errors)),
            "folds_detail": folds_detail,
        }
    return {"params": fit_holt(series), "holdout": holdout}


def fit_series(series: list[float], horizon: int = 7) -> dict:
    evaluation = evaluate_holdout(series, horizon)
    params = evaluation["params"]
    return {
        "alpha": params["alpha"],
        "beta": params["beta"],
        "phi": params["phi"],
        "horizon": horizon,
        "samples": len(series),
        "in_sample_mae": params.get("in_sample_mae"),
        "holdout": evaluation.get("holdout"),
        "note": evaluation.get("note"),
    }
