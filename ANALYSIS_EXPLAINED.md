# What Analysis SmartMed Does — Explained Simply

This document explains, in plain English, **every analysis** the SmartMed dashboard performs:
what it measures, what data it uses, and which research paper it comes from.

For formal citations and the full literature survey, see [`RESEARCH_BASIS.md`](RESEARCH_BASIS.md).

---

## 1. What data are we analysing?

The system produces two things in Firebase. Everything below comes from comparing them.

### The plan — `schedules/{patientId}`
What the patient is *supposed* to do:

> "Metformin, 08:00, compartment 1, every day"

### The reality — `history/{patientId}`
One record each time the box fires an alarm and watches the IR sensor:

> "2026-03-04, 09:35, **Taken**, Metformin, was due 08:00, 95 minutes late"

That's it — **a plan, and a record of what actually happened.**

Researchers call this "electronic monitoring data," and it has been studied for over 20 years.
That means we do not have to invent metrics; we can use ones that are already validated.

---

## 2. Cleaning the data first (2 rules)

> **Source: Paper 2** — McGrady & Ramsey (2020)

Before any maths, two real-world problems get corrected.

### Rule 1 — One dose being counted twice

Your IR sensor is a beam. A patient reaching in can break it **twice** while taking a single
pill. Raw data makes that look like two doses.

**The rule:** two triggers on the same compartment within **30 minutes** count as **one dose**.
Keep the first, discard the second.

```
08:02  Taken  ┐
              ├──►  counts as ONE dose, at 08:02
08:07  Taken  ┘
```

### Rule 2 — Days the patient legitimately wasn't dosing

If someone is in hospital for three days, they are not "non-adherent" — they simply were not
on the regimen.

**The rule:** those days are **removed from both the top and bottom of the fraction**. Not
scored as 0%, not counted at all.

---

## 3. The three main numbers

> **Source: Paper 2** — McGrady & Ramsey (2020)

Here is a real 7-day example, taken from the project's test file so the arithmetic is verified.

**The plan:** 3 doses per day — 08:00, 14:00, 20:00. Plus one extra one-off dose on Friday.

| Day | Due (P) | Taken (N) | On time | What happened |
|---|---|---|---|---|
| Mon 03-02 | 3 | 3 | 3 | perfect day |
| Tue 03-03 | 3 | 2 | 2 | evening dose missed |
| Wed 03-04 | 3 | 3 | 2 | all taken, but one was 95 min late |
| Thu 03-05 | 3 | — | — | **excluded** (hospital day) |
| Fri 03-06 | **4** | 0 | 0 | nothing taken |
| Sat 03-07 | 3 | 3 | 3 | perfect day |
| Sun 03-08 | 3 | 2 | 2 | evening dose missed |

### Analysis 1 — Taking adherence
**Question: did they take their pills at all?**

Doses taken ÷ doses due.

```
Daily:  100%,  66.7%,  100%,  —,  0%,  100%,  66.7%
Average of those six days  =  72.2%
```

### Analysis 2 — Timing adherence
**Question: did they take them at roughly the right time?**

The same calculation, but a dose only counts if it was taken **within ±60 minutes** of when
it was due.

Wednesday shows why this matters: all 3 doses were taken, but one arrived 95 minutes late.
So Wednesday scores **100% on taking** and only **66.7% on timing**.

```
Daily:  100%,  66.7%,  66.7%,  —,  0%,  100%,  66.7%
Average  =  66.7%
```

### Analysis 3 — Correct-dosing days
**Question: how many days were completely right?**

All-or-nothing. A day only passes if **every** dose was taken.

```
3 clean days out of 6 scored days  =  50%
```

---

## 4. ⚠️ The rule that is easiest to get wrong

Paper 2 requires you to calculate **each day separately, then average the days.**
You must **not** add up all the doses and divide once.

Using the example above:

| Method | Result |
|---|---|
| ✅ Correct — average the daily values | **72.2%** |
| ❌ Wrong — pool everything (13 doses ÷ 19 due) | 68.4% |

Different answers from the same data.

The project's test file deliberately checks for this. If someone later "simplifies" the code
and reintroduces pooling, `analytics.test.js` fails immediately.

**Why it matters:** a patient who takes 6 doses on Monday and 0 on Tuesday should not score
100%. Averaging days keeps each day equally weighted.

---

## 5. ⚠️ Why we show THREE numbers, not one

> **Source: Paper 4** — Rohay & Dunbar-Jacob (2024)

A very common misunderstanding is that the three metrics get combined into a single
"adherence score." **They do not.** They are three independent percentages shown side by side:

```
┌──────────────┬──────────────┬────────────────────┐
│   TAKING     │   TIMING     │  CORRECT-DOSING    │
│    72.2%     │    66.7%     │       50.0%        │
│  13 of 19    │  12 of 19    │    3 of 6 days     │
└──────────────┴──────────────┴────────────────────┘
```

Paper 4 measured the **same patients** three different ways:

| Method | Result |
|---|---|
| Just count the pills | 89–92% |
| Count per day | 79–85% |
| Include timing | **62–68%** |

**Same people. Same behaviour. A 25-point swing** based purely on the calculation method.

So a single "adherence %" is meaningless without stating its definition. Merging the three
into one number would destroy exactly the information the paper identified.

**The gap between taking and timing IS the signal.** A large gap means the patient takes
their medicine but at erratic hours — a different clinical problem from simply forgetting.

Paper 4 also found patients vary *when* they dose more than *whether* they dose, which makes
timing the more sensitive early warning for a caregiver.

---

## 6. The heatmap — *when* doses get missed

> **Source: Burnier (2018)** — supporting reference

This paper describes patterns that **only** electronic monitoring can reveal (a pill count
cannot see any of them):

- **Weekend effect** — adherence drops on Saturday and Sunday
- **Time-of-day drift** — evening doses are missed far more than morning ones
- **Drug holidays** — the patient stops for 2–3 days, then resumes

### ⚠️ The 7 rows are days of the WEEK — not the last 7 days

This is the second common misunderstanding. The heatmap pours the **entire observation
window** into 7 weekday buckets. On a 30-day window, roughly four Mondays stack into the
Monday row.

```
          08:00   14:00   20:00
  Mon       5%      8%      40%
  Tue       0%     12%      35%
  Wed       6%      5%      38%
  Thu       4%     10%      42%
  Fri       8%     14%      45%
  Sat      18%     22%      70%   ◄── weekend + evening = worst
  Sun      20%     15%      65%
```

**Why stack them?** One Monday tells you nothing. Four Mondays reveals a *habit*.

It answers **"which slot does this patient repeatedly fail?"** — not "what happened last week?"

The columns are not fixed either: it only shows hours that actually have doses scheduled.
Three schedules produce three columns.

Cells based on very few doses are **dimmed**, because 1 miss out of 1 dose is technically
"100% missed" but should not shout as loudly as 5 misses out of 20.

---

## 7. The supporting numbers

Shown in the "Window detail" panel:

| Number | What it tells you |
|---|---|
| Median lateness | The typical delay — e.g. "usually 9 minutes late" |
| Latest dose | The worst delay in the period |
| Repeat actuations removed | How many double-triggers Rule 1 caught |
| Days excluded | How many hospital / non-use days were dropped |

---

## 8. What framework is this part of?

> **Source: Paper 1** — Vrijens et al. (2012), the "ABC taxonomy"

This is the standard vocabulary in adherence research. It splits adherence into three phases:

| Phase | Question |
|---|---|
| **Initiation** | Did the patient ever take the first dose? |
| **Implementation** | Are they following the regimen day to day? |
| **Persistence** | Have they stopped taking it altogether? |

**Everything SmartMed measures is the Implementation phase.** That is the honest label, and
it is what the dashboard's Methods panel states.

---

## 9. Where each piece comes from

A frequent assumption is that all of this comes from one paper. It does not:

| Component | Source |
|---|---|
| The 3 metrics + both cleaning rules | **Paper 2** — McGrady & Ramsey 2020 |
| Showing the three side by side, not merged | **Paper 4** — Rohay & Dunbar-Jacob 2024 |
| The weekday × hour heatmap | **Burnier 2018** (supporting reference) |
| Calling it "Implementation-phase" adherence | **Paper 1** — Vrijens et al. 2012 |
| Per-dose risk model | **Paper 5** — Gu et al. 2021 (*Sci Rep*) |
| 7-day forecast | **Paper 6** — Hyndman & Athanasopoulos 2021 |
| Probability correction | **Paper 7** — Saerens et al. 2002 |

Paper 2 is the largest contributor, but it does **not** cover the heatmap or the side-by-side
reporting decision.

---

## 10. What we deliberately did NOT build

Documented on purpose — it shows the field was surveyed and a scope choice was made, rather
than things being overlooked.

| Not built | From | How to add it later |
|---|---|---|
| Sliding-window adherence | Paper 3 (AdhereR) | Reads straight off the existing daily table |
| Drug-holiday detection | Paper 3 / Burnier | Find runs of consecutive zero-dose days |
| Variability (monthly SD) | Paper 4 | One standard-deviation call on the daily values |
| Initiation & persistence | Paper 1 | First-dose date and last-dose date |
| LSTM / sequence risk model | Paper 5 | Needs far more real per-patient history than the pilot provides |
| TinyML / on-device inference | Paper 5 | Adds embedded risk; static JS inference is enough for the demo |

All four appear in `RESEARCH_BASIS.md` with "No" in the implemented column. The daily table
produced by `buildDailyTable()` in `dashboard/analytics.js` is the right starting point for
all of them.

---

## 11. One-page summary

| Analysis | Question it answers | Data used | Source |
|---|---|---|---|
| 30-minute dedup | Is this one dose or two? | IR triggers + compartment | Paper 2 |
| Non-use exclusion | Was this a fair day to judge? | Flagged dates | Paper 2 |
| Taking adherence | Did they take their pills? | Plan vs. Taken events | Paper 2 |
| Timing adherence | At roughly the right time? | Scheduled time vs. actual time | Paper 2 |
| Correct-dosing days | How many fully-correct days? | Daily dose counts | Paper 2 |
| All three side by side | Which number is honest? | — | Paper 4 |
| Miss heatmap | *When* do they slip? | Weekday + scheduled hour | Burnier 2018 |
| Phase labelling | What are we actually measuring? | — | Paper 1 |
| Next-dose risk | Which upcoming dose needs attention? | Prior adherence + slot + calendar | Paper 5 |
| 7-day forecast | Where is adherence heading? | Daily taking/timing series | Paper 6 |

**In one sentence:** we compare the prescribed schedule against the IR-sensor event log,
clean it using two rules from the 2020 EAMD framework, report three standard adherence
percentages plus a picture of when misses cluster, and use past dose history to rank the
risk of the upcoming doses and project the next 7 days.

---

## 12. How to see it running

1. Open the dashboard and log in as normal.
2. Make sure the patient has at least one schedule (**Scheduler** tab).
3. Go to **Settings → System Sim-Suite → Seed history**, enter `60`, click **SEED**.
   (Real device history is near-empty, so the charts need data to show.)
4. Open the **Analytics** tab.

**Clear simulated data** removes only the seeded records and leaves real device events alone.
Any window containing simulated events shows an amber warning banner.

### Checking the maths yourself

```bash
node dashboard/analytics.test.js
node dashboard/ml-risk.test.js
```

The first suite runs 27 assertions against hand-worked arithmetic, including the pooling guard
described in section 4, the 30-minute dedup rule, the excluded non-use day, and the
95-minute-late dose. The second checks the Python↔JavaScript feature parity fixture, the
leakage guard, risk-score bounds, and the forecast shape.

### Viewing the layout without logging in

Sign in and use **More > Device & settings > Developer tools > Create / refresh demo patient**.
It builds a demo patient with 60 days of dose events against the real backend, no manual
wiring needed.

---

## 13. The AI layer (risk radar + 7-day forecast)

The analytics sections above say what **has happened**. This section predicts what is
**likely to happen next**. It is still a small, explainable layer — not a black box and not a
diagnosis.

### 13.1 What it predicts

There are two outputs on the Analytics tab:

1. **Next-dose risk.** For every scheduled dose in the next 7 days, the model outputs a
   probability that the dose will be **missed or taken more than 60 minutes late**.
   The card groups repeated days into schedule patterns, shows up to three, and explains
   each in plain language.
2. **7-day forecast.** The daily taking and timing lines are extended with a dashed
   projection. It smooths the recent level; it is not recorded data.

The Overview header also shows a compact chip for the next dose, e.g. `Next dose 72% HIGH`.
The chip hides when the risk card is paused for missing recent data.

### 13.2 How the risk model works, in plain English

1. **Build the features from the past only.** At the moment a dose is due, the model is allowed
   to know: recent adherence (7/14/30 days), how many doses in a row were missed, the median
   lateness, days since the last miss, this slot's miss rate, this weekday's miss rate, the
   previous dose's outcome, and the usual delay for this slot. It is **not** allowed to see the
   dose it is predicting. That is the golden rule; a leakage test enforces it. Future-dose
   scores also stop at the last **completed** day, so today's not-yet-recorded doses are never
   counted as misses.
2. **Learn weights from labelled history.** Each past dose is labelled non-adherent if it was
   missed or more than 60 minutes off schedule. A logistic regression learns how the features
   push that probability up or down.
3. **Correct the base rate.** Because missed doses are the minority, the learner is told to
   care about them equally (class weighting), which inflates raw probabilities. The intercept
   is then adjusted so the average predicted risk matches the observed non-adherence rate.
4. **Export frozen weights.** Only the final coefficients and scaling constants are copied to
   `dashboard/ml-model.js`. The browser evaluates a short formula — no Python, no server, no
   training at demo time.

### 13.3 What the numbers mean

| Display | Meaning |
|---|---|
| `Very high` | estimated probability ≥ 90% |
| `High` | 60–89% |
| `Medium` | 30–59% |
| `Low` | below 30% |
| `72%` | Of past doses with this pattern, roughly 72 in 100 were non-adherent |
| Reasons under a dose | Plain-language sentences with the underlying values, e.g. "Missed the last 4 doses" |

It is a **prioritisation tool**: the top of the list is where a caregiver should check in
first. It is not evidence that a specific patient will skip a specific pill, and it does not
detect ingestion.

**When the card pauses.** If no dose event has been received for 3 days while doses were due,
the card says **Risk paused** instead of producing a score. A silent box — flat battery,
Wi-Fi off, or patient not using the system — is missing data, not proof of missed doses.
Scoring resumes automatically when recent events arrive. This avoids the failure mode where a
stale device produces 99% risk for every future dose.

### 13.4 How the forecast works

The daily adherence series is noisy — one bad evening can drop a day from 100% to 33%. The
forecast uses **damped Holt exponential smoothing**: it tracks the current level and a trend,
but the trend flattens out over the 7-day horizon so it cannot run away. The parameters come
from a grid search on the training series, and the result is compared against the simplest
possible baseline ("tomorrow equals today") using a rolling-origin backtest.

On the current synthetic series the forecast's average error is about the same as the naive
baseline (MAE ≈7.0 percentage points). That is stated openly in the model card: for a stable,
noisy behaviour series, beating "last value" is hard. The forecast's job in the demo is to
smooth the recent direction, not to promise precision.

### 13.5 What data trained it

| Source | Used for |
|---|---|
| 40 simulated patients × 120 days = 14,400 labelled doses | fitting the weights and the simulated holdout metrics |
| Real pilot events (3–5 volunteers, 3–4 days) | intercept calibration once ≥20 usable rows exist, plus a separate real evaluation; never used to inflate the simulated numbers |

The simulator encodes behavioural patterns from the literature: weekend effects, evening
drift, long delays, occasional drug holidays, and persistent differences between patients.
Those patterns are a **prior**, not proof about real people.

### 13.6 Honest performance

On the simulated temporal holdout (the last 20% of days, never seen in training):

| Model | Accuracy | ROC-AUC |
|---|---|---|
| Logistic regression (shipped) | 0.674 | 0.684 |
| Random forest (benchmark) | 0.634 | 0.689 |
| Gradient boosting (benchmark) | 0.678 | 0.685 |

Why not higher? The label is random at the individual-dose level by construction, the
history is short, and the model deliberately avoids clinical covariates. Published per-dose
models with hundreds of thousands of real events and long histories reach AUC ≈0.84
(Gu et al., *Sci Rep* 2021), which is the right comparison point — and the reason our model
card states its limits instead of borrowing that number.

The real pilot is too small for a stable AUC. Once it reaches 20 usable rows it also shifts
the intercept; below that the simulated prior is kept, and the card reports how many rows
were found. Real metrics are reported separately whenever there are enough events and both
outcome classes.

### 13.7 Why logistic regression and not a neural network

- A clinician can read 17 coefficients and the reasons panel; that matters more than a few
  AUC points in a 4-day project.
- Small real samples make flexible models unstable; the scoping literature finds logistic
  regression and random forests among the most frequent top performers.
- The same model can be evaluated in pure JavaScript with a parity test against Python,
  removing the train/serve skew that causes silent ML bugs.

### 13.8 How to check it

```bash
python ml/train_risk.py          # retrain + rewrite model, JS, model card
node dashboard/ml-risk.test.js   # feature parity, leakage guard, scoring, forecast
node dashboard/analytics.test.js # existing analytics still correct
```

The parity test loads a fixture produced by `ml/features.py` and asserts that every feature
value from the Python builder is reproduced by `dashboard/ml-risk.js` to 1e-9. If the two ever
drift, the test fails before the dashboard does.

---

## Where the code lives

| File | Role |
|---|---|
| `dashboard/analytics.js` | All the maths. Pure functions — no dashboard, no Firebase. |
| `dashboard/analytics-ui.js` | Drawing only. Reads results from `analytics.js`. |
| `dashboard/analytics.test.js` | The 27 verification assertions. |
| `dashboard/ml-model.js` | Frozen model weights exported by the training script. |
| `dashboard/ml-risk.js` | Browser inference: risk scores, reasons, 7-day forecast. |
| `dashboard/ml-risk.test.js` | Parity, leakage, scoring and forecast assertions. |
| `ml/features.py` | Shared feature definitions and the parity fixture. |
| `ml/train_risk.py` | Training, calibration, benchmarks and export. |
| `ml/forecast.py` | Damped Holt fit and rolling-origin backtest. |
| `ml/model_card.md` | Metrics, data sources and limitations for this model version. |
| `firmware/SmartMedicineBox/SmartMedicineBox.ino` | Logs which scheduled dose fired, so timing can be measured. |
| `RESEARCH_BASIS.md` | Formal citations and the full literature survey. |

The maths is kept separate from the drawing on purpose: it means every number on screen can
be tested and audited independently of the user interface.
