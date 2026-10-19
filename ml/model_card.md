# SmartMed ML Model Card

**Version:** 1.0.0  ·  **Trained:** 2026-10-19T18:25:02  ·  **Model:** logistic regression

## Purpose
Predict the probability that an upcoming scheduled dose will be **missed or taken more than
60 minutes late** (a non-adherent dose). Predictions are per-dose, made from strictly past
history, and surfaced to the caregiver as a ranked risk list.

## Data sources
| Source | Labelled doses | Patients |
|---|---|---|
| Simulated pretraining | 14400 | 40 |
| Real pilot rows | 6 | 1 |

Simulated events encode weekend effects, evening drift, long delays and occasional drug
holidays. They are used to fit the feature weights. Real rows are used only for
calibration and evaluation — never to fabricate the headline metrics.

## Features (17)
hour_sin, hour_cos, weekday_sin, weekday_cos, is_weekend, compartment, slot_index, roll7_taking, roll14_taking, roll30_taking, miss_streak, median_lateness_7d, days_since_last_miss, slot_miss_rate_14d, weekday_miss_rate_28d, last_outcome, slot_median_delay_14d

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
| Accuracy | 0.674 |
| ROC-AUC | 0.684 |
| Precision | 0.548 |
| Recall | 0.306 |
| Brier | 0.205 |
| Events | 2880 |

## Benchmark (simulated temporal holdout)
| Model | Accuracy | AUC | Precision | Recall |
|---|---|---|---|---|
| Logistic regression (production) | 0.674 | 0.684 | 0.548 | 0.306 |
| Random forest | 0.634 | 0.689 | 0.477 | 0.667 |
| Gradient boosting | 0.678 | 0.685 | 0.570 | 0.263 |

Logistic regression is the production model because its coefficients can be explained to a
clinician and it is stable on small real samples. Tree ensembles are benchmarked for
due diligence only.

## Real pilot calibration and evaluation
6 usable real dose rows from 1 patient(s) — below the 20-row minimum for calibration and evaluation.

Simulated holdout intercept correction: observed rate 0.344. Real pilot has 6 usable rows, below the 20-row minimum; the simulated prior was retained.

## 7-day adherence forecast
Damped Holt linear-trend exponential smoothing, alpha=0.90,
beta=0.00, phi=0.80.
Rolling-origin backtest (4 x 7-day folds): MAE 7.00 pp vs naive 7.05 pp. The dashboard applies the frozen
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
