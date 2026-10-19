# SmartMed Real-Data Collection Protocol

**Purpose:** collect a small, ethically clean set of real dose events so the risk model is
not calibrated only on simulated behaviour. The model is pretrained on simulation, then its
intercept (base rate) and evaluation are updated with real pilot data. Real events never
replace the reported simulated metrics; both are shown separately in `ml/model_card.md`.

**Time budget:** 4 days from setup to the presentation (one evening for rigs, 3–4 days of
recording, final retrain on the morning of the demo).

---

## 1. Design

| Item | Decision |
|---|---|
| Unit of observation | 1 SmartMed box = 1 participant |
| Participants | 3–5 adults, volunteers only |
| Duration | 3–4 full days (at least 9–12 doses per participant) |
| Doses per day | 3 (08:00, 14:00, 20:30) — include one evening dose |
| Medication | **Dummy pills or the participant's own vitamins**, never a study-assigned drug |
| Primary outcome | `non_adherent = missed OR \|actual − scheduled\| > 60 min` |
| Privacy | No names, ages, conditions, or diagnoses in the ML export; only timing logs and patient IDs |

One box per participant is essential. If two people share a box, the history mixes their
behaviour and the model learns an average that fits neither.

### Why dummy pills

The IR sensor sees a hand entering a compartment; it cannot verify ingestion. Using dummy
pills avoids any clinical risk and keeps the study at "device usability" level. If a
participant wants to use their own prescribed medication, they may do so **without changing
their normal routine**, but the study must not ask them to alter a real regimen. When in
doubt, use placebo/dummy pills.

### Consent script (read aloud, one minute)

> "This is a class project testing a medication box. The box records only the date, time,
> and which compartment was opened. It does not record who you are or what you take. You can
> stop at any time and we will delete your data. The results are for a demo, not medical
> advice. Please use dummy pills/vitamins that we provide, not medication we give you.
> Is it okay to proceed?"

Record verbal consent in a private notebook (participant ID + date + yes/no). Do **not**
store the consent record in Firebase. Check whether your institution requires a short ethics
form; a usability study with dummy pills and no identifiable data is usually exempt, but the
supervisor's signature is the safe route.

---

## 2. Hardware and setup (evening before)

For each rig:

1. Flash the existing `firmware/SmartMedicineBox/SmartMedicineBox.ino` unchanged (IR beam,
   RTC, Wi-Fi, Firebase). LCD and buzzer are optional; the IR + RTC path is what matters.
2. Open the serial monitor and confirm Wi-Fi, NTP/RTC time, and Firebase writes.
3. Create a **new patient** in the dashboard and pair the box with that patient's UID.
4. Add exactly three daily schedules, starting **today or tomorrow**, with stable times:
   - 08:00 — compartment 1 — dummy pill A
   - 14:00 — compartment 2 — dummy pill B
   - 20:30 — compartment 3 — dummy pill C
5. Trigger each sensor once and confirm a `Taken` record appears under `history/{uid}` with
   `simulated` absent or `false`.
6. Label the compartments physically (1/2/3) and show the participant which pill is in which.
7. **Do not seed simulated history** into a real participant. If you did, use
   "Clear simulated data" in Settings before exporting — `fetch_firebase.py` also drops
   records tagged `simulated: true`, but a clean dataset is easier to defend.

---

## 3. Daily operation (3–4 days)

- Participants follow their normal life. Do not remind them to open the box; the point is to
  observe natural behaviour.
- If a dose is missed, the firmware logs a `Missed` record at the end of the monitoring
  window. Leave it.
- Record exceptions outside Firebase (paper or a notes file): travel, device unplugged,
  hospital visit, visitor opened the box, etc. These can be treated as documented non-use
  when interpreting results.
- Do not change schedule times mid-study. If a time must change, note the exact timestamp
  and either keep that participant's data out of the calibration set or accept the
  discontinuity explicitly.
- Check once per day that events are arriving (dashboard or Firebase console). A rig that
  silently went offline produces false "misses" for every dose in the gap. If the risk card
  says **Risk paused**, treat it as a device/data problem first, not as evidence that the
  participant stopped taking doses.

---

## 4. Export and retrain (demo morning)

Set the caregiver login as environment variables (never commit them):

```powershell
$env:SMARTMED_EMAIL = "the-caregiver-login"
$env:SMARTMED_PASSWORD = "the-password"
python ml/fetch_firebase.py
python ml/train_risk.py --sim ml/data/simulated.json --real ml/data/real_data.json
```

`ml/data/real_data.json` is gitignored because it contains volunteer event logs.

Then check:

1. `ml/data/real_data.json` contains only real events (no `"simulated": true`).
2. `ml/model_card.md` reports the real event/patient counts and the real holdout metrics.
3. `dashboard/ml-model.js` timestamp is today's.
4. Reload the dashboard and confirm the risk card lists upcoming doses with sensible values.

### Minimum useful sample

The training script will **not** shift the model's intercept below **20 usable labelled
rows** — with fewer, a handful of events would swing the probabilities more than the
simulation prior, so the simulated prior is retained and the card says how many rows were
found. The bands below describe what can be claimed once that minimum is met.

| Real events | What can be claimed |
|---|---|
| 0 | Simulated prior only. Say so explicitly; do not present simulated metrics as real. |
| 30–60 | Enough to shift the intercept/base rate; AUC is unstable and should be omitted or heavily caveated. |
| 60–120 | A provisional real holdout (last 20% of days) with wide confidence intervals. |
| 120+ | A meaningful temporal holdout; report accuracy/AUC with the sample size attached. |

With 3 participants × 4 days × 3 doses = 36 doses, expect only ~10–12 non-adherent doses.
That is enough for calibration, not for a strong AUC claim. The presentation should say
"real pilot used for calibration; accuracy estimates come from the larger simulated
temporal holdout and will firm up as the pilot grows."

If there are fewer than two outcome classes in the real holdout, the training script sets
the real AUC to `null` rather than inventing a number.

---

## 5. Analysis and reporting guardrails

- Report **both** simulated-holdout and real-pilot metrics, labelled by source.
- Never pool simulated and real events into a single "real" accuracy figure.
- State the target definition (`missed OR >60 min late`) next to the metric.
- The label is device-observed behaviour, not ingestion; write "dose events", not "pills
  swallowed".
- Rank ordering matters more than the absolute probability for a small calibration set.
  Use the risk radar to prioritise check-ins, not to diagnose non-adherence.
- If the pilot shows almost no misses (novelty effect), report that honestly: the model's
  base rate is low and the risk list will mostly be "low". That is a valid result.

---

## 6. Ethics references used

- Electronic monitoring methods and non-use exclusion: McGrady & Ramsey, *J Gen Intern Med*
  2020;35(9):2707–2714. See `RESEARCH_BASIS.md` P2.
- Small-N EAMD feasibility and device-acceptance precedent: Haberer et al., *AIDS Behav*
  2010;14(6):1340–1346 (PMC2911441), which used short electronic-monitoring pilots to
  characterise adherence behaviour rather than to prove clinical efficacy.
- No data from the pilot is used for any clinical claim or treatment decision.
