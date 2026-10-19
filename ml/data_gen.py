"""Generate a bootstrapping dataset in the SmartMed Firebase schema.

The generator deliberately encodes the same behavioural structure the dashboard
Sim-Suite produces (weekend effect, evening drift, occasional double triggers)
plus patient-level traits and rare drug holidays, so the risk model pretrained
on it has a realistic prior before real pilot events arrive.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import date, datetime, time, timedelta
from pathlib import Path

SLOTS = [
    (8, 0, 1, "Metformin"),
    (14, 0, 2, "Amlodipine"),
    (20, 30, 3, "Atorvastatin"),
]


def _time_string(hour: int, minute: int) -> str:
    return f"{hour:02d}:{minute:02d}"


def _event(date_str: str, hour: int, minute: int, status: str, med: str, compartment: int,
           scheduled: str, delay_sec: int, epoch: int) -> dict:
    return {
        "date": date_str,
        "time": _time_string(hour, minute),
        "status": status,
        "medName": med,
        "compartment": compartment,
        "scheduledTime": scheduled,
        "delaySec": delay_sec,
        "epoch": epoch,
        "simulated": True,
    }


def generate_patient(rng: random.Random, patient_id: str, start: date, days: int) -> dict:
    reliability_group = rng.choices([0, 1, 2], weights=[0.25, 0.45, 0.30], k=1)[0]
    if reliability_group == 0:
        base_probability = rng.uniform(0.52, 0.70)
    elif reliability_group == 1:
        base_probability = rng.uniform(0.76, 0.89)
    else:
        base_probability = rng.uniform(0.92, 0.99)
    evening_penalty = rng.uniform(0.05, 0.32)
    weekend_penalty = rng.uniform(0.02, 0.18)
    long_delay_probability = rng.uniform(0.01, 0.12)
    double_trigger_probability = rng.uniform(0.02, 0.06)
    holiday_probability = rng.uniform(0.0, 0.035)

    schedules = {}
    for index, (hour, minute, compartment, med) in enumerate(SLOTS, start=1):
        schedules[f"s{index}"] = {
            "medName": med,
            "time": _time_string(hour, minute),
            "compartment": compartment,
            "date": start.strftime("%Y-%m-%d"),
            "frequency": "daily",
            "active": True,
        }

    history = {}
    counter = 0
    holiday_until = None

    for offset in range(days):
        day = start + timedelta(days=offset)
        date_str = day.strftime("%Y-%m-%d")
        weekday = (day.weekday() + 1) % 7
        is_weekend = weekday in (0, 6)

        if holiday_until is not None and day <= holiday_until:
            day_is_holiday = True
        elif rng.random() < holiday_probability:
            holiday_until = day + timedelta(days=rng.choice([1, 1, 2]))
            day_is_holiday = True
        else:
            day_is_holiday = False

        for hour, minute, compartment, med in SLOTS:
            scheduled = _time_string(hour, minute)
            scheduled_minutes = hour * 60 + minute
            taken_probability = base_probability
            if hour >= 19:
                taken_probability -= evening_penalty
            if is_weekend:
                taken_probability -= weekend_penalty
            if day_is_holiday:
                taken_probability = 0.0
            taken_probability = max(0.05, min(0.99, taken_probability))

            if rng.random() >= taken_probability:
                counter += 1
                epoch = int(datetime.combine(day, time(hour, minute)).timestamp())
                history[f"sim_{date_str}_{counter:05d}"] = _event(
                    date_str, hour, (minute + 1) % 60, "Missed", med, compartment,
                    scheduled, 60, epoch,
                )
                continue

            delay = rng.randint(0, 12)
            if hour >= 19:
                delay += rng.randint(0, 30)
            long_probability = long_delay_probability * (1.6 if hour >= 19 else 1.0)
            if rng.random() < long_probability:
                delay += rng.randint(45, 105)
            actual_minutes = min(scheduled_minutes + delay, 23 * 60 + 58)
            actual_hour, actual_minute = divmod(actual_minutes, 60)
            counter += 1
            epoch = int(datetime.combine(day, time(actual_hour, actual_minute)).timestamp())
            history[f"sim_{date_str}_{counter:05d}"] = _event(
                date_str, actual_hour, actual_minute, "Taken", med, compartment,
                scheduled, (actual_minutes - scheduled_minutes) * 60, epoch,
            )

            if rng.random() < double_trigger_probability:
                repeat_minutes = min(actual_minutes + rng.randint(3, 8), 23 * 60 + 59)
                repeat_hour, repeat_minute = divmod(repeat_minutes, 60)
                counter += 1
                history[f"sim_{date_str}_{counter:05d}"] = _event(
                    date_str, repeat_hour, repeat_minute, "Taken", med, compartment,
                    scheduled, (repeat_minutes - scheduled_minutes) * 60, epoch,
                )

    return {"schedules": schedules, "history": history}


def generate_dataset(patients: int = 40, days: int = 120, seed: int = 27) -> dict:
    rng = random.Random(seed)
    start = date.today() - timedelta(days=days)
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "seed": seed,
        "days": days,
        "patients": {
            f"SIM{index:03d}": generate_patient(rng, f"SIM{index:03d}", start, days)
            for index in range(1, patients + 1)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--patients", type=int, default=40)
    parser.add_argument("--days", type=int, default=120)
    parser.add_argument("--seed", type=int, default=27)
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "data" / "simulated.json")
    args = parser.parse_args()

    dataset = generate_dataset(args.patients, args.days, args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(dataset), encoding="utf-8")

    events = sum(len(p["history"]) for p in dataset["patients"].values())
    print(f"Wrote {args.out} ({len(dataset['patients'])} patients, {events} events)")


if __name__ == "__main__":
    main()
