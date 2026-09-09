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

**In one sentence:** we compare the prescribed schedule against the IR-sensor event log,
clean it using two rules from the 2020 EAMD framework, and report three standard adherence
percentages plus a picture of when misses cluster.

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
```

27 assertions run against hand-worked arithmetic, including the pooling guard described in
section 4, the 30-minute dedup rule, the excluded non-use day, and the 95-minute-late dose.

### Viewing the layout without logging in

Open `dashboard/_analytics-preview.html` directly in a browser. It renders the Analytics tab
against generated data with no Firebase connection. It is a development helper only and is
safe to delete.

---

## Where the code lives

| File | Role |
|---|---|
| `dashboard/analytics.js` | All the maths. Pure functions — no dashboard, no Firebase. |
| `dashboard/analytics-ui.js` | Drawing only. Reads results from `analytics.js`. |
| `dashboard/analytics.test.js` | The 27 verification assertions. |
| `firmware/SmartMedicineBox/SmartMedicineBox.ino` | Logs which scheduled dose fired, so timing can be measured. |
| `RESEARCH_BASIS.md` | Formal citations and the full literature survey. |

The maths is kept separate from the drawing on purpose: it means every number on screen can
be tested and audited independently of the user interface.
