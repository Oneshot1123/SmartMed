"""Feature construction for the SmartMed dose-risk model.

Mirrors dashboard/analytics.js so the Python training pipeline and the JS
inference layer produce identical feature vectors.
"""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta

TIMING_WINDOW_MIN = 60
DEDUP_WINDOW_MIN = 30

FEATURES = [
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
    "is_weekend",
    "compartment",
    "slot_index",
    "roll7_taking",
    "roll14_taking",
    "roll30_taking",
    "miss_streak",
    "median_lateness_7d",
    "days_since_last_miss",
    "slot_miss_rate_14d",
    "weekday_miss_rate_28d",
    "last_outcome",
    "slot_median_delay_14d",
]

DEFAULT_TAKING = 85.0
DEFAULT_DAYS_SINCE_MISS = 30
DEFAULT_MEDIAN_LATENESS = 0.0
MAX_STREAK = 20


def date_key(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def parse_date_key(key: str) -> date:
    year, month, day = (int(p) for p in str(key).split("-")[:3])
    return date(year, month, day)


def add_days(d: date, n: int) -> date:
    return d + timedelta(days=n)


def time_to_minutes(value) -> int | None:
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if hour > 23 or minute > 59 or hour < 0 or minute < 0:
        return None
    return hour * 60 + minute


def minutes_to_time(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _weekday_sunday_zero(d: date) -> int:
    return (d.weekday() + 1) % 7


def normalise_history(history: dict) -> list[dict]:
    events = []
    for key, raw in (history or {}).items():
        if not raw or not raw.get("date") or not raw.get("status"):
            continue
        minutes = time_to_minutes(raw.get("time"))
        if minutes is None:
            continue
        try:
            day = parse_date_key(raw["date"])
        except (ValueError, IndexError):
            continue
        compartment = raw.get("compartment")
        events.append(
            {
                "id": key,
                "date_key": raw["date"],
                "date": day,
                "minutes": minutes,
                "status": raw["status"],
                "taken": raw["status"] == "Taken",
                "med_name": raw.get("medName"),
                "compartment": None if compartment is None else str(compartment),
                "scheduled_minutes": time_to_minutes(raw.get("scheduledTime")),
                "delay_sec": raw.get("delaySec") if isinstance(raw.get("delaySec"), (int, float)) else None,
                "simulated": raw.get("simulated") is True,
            }
        )
    events.sort(key=lambda e: (e["date_key"], e["minutes"]))
    return events


def dedupe_actuations(events: list[dict], window_min: int = DEDUP_WINDOW_MIN) -> list[dict]:
    last_by_group: dict[str, int] = {}
    kept = []
    removed = 0
    for event in events:
        if not event["taken"]:
            kept.append(event)
            continue
        group = (
            event["date_key"]
            + "|"
            + (event["compartment"] or event["med_name"] or "*")
            + ("|" + str(event["scheduled_minutes"]) if event["scheduled_minutes"] is not None else "")
        )
        previous = last_by_group.get(group)
        if previous is not None and event["minutes"] - previous <= window_min:
            removed += 1
            continue
        last_by_group[group] = event["minutes"]
        kept.append(event)
    return kept, removed


def expand_prescribed(schedules: dict, from_key: str, to_key: str) -> dict[str, list[dict]]:
    by_date: dict[str, list[dict]] = {}
    start_day = parse_date_key(from_key)
    end_day = parse_date_key(to_key)
    day = start_day
    while day <= end_day:
        by_date[date_key(day)] = []
        day = add_days(day, 1)

    for schedule_id, schedule in (schedules or {}).items():
        if not schedule:
            continue
        minutes = time_to_minutes(schedule.get("time"))
        if minutes is None:
            continue
        slot = {
            "id": schedule_id,
            "med_name": schedule.get("medName") or "Unnamed",
            "compartment": None if schedule.get("compartment") is None else str(schedule.get("compartment")),
            "minutes": minutes,
            "time": minutes_to_time(minutes),
        }
        if schedule.get("frequency") == "daily":
            start = parse_date_key(schedule["date"]) if schedule.get("date") else start_day
            for key in by_date:
                if parse_date_key(key) >= start:
                    by_date[key].append(slot)
        elif schedule.get("date") in by_date:
            by_date[schedule["date"]].append(slot)

    for key in by_date:
        by_date[key].sort(key=lambda s: s["minutes"])
    return by_date


def match_day(slots: list[dict], events: list[dict]) -> dict:
    assignments = [
        {"slot": slot, "event": None, "on_time": False, "delta_min": None} for slot in slots
    ]
    extra = []
    pending = []

    for event in events:
        if not event["taken"]:
            continue
        if event["scheduled_minutes"] is not None:
            exact = -1
            for index, assignment in enumerate(assignments):
                if assignment["event"] or assignment["slot"]["minutes"] != event["scheduled_minutes"]:
                    continue
                if (
                    event["compartment"]
                    and assignment["slot"]["compartment"]
                    and event["compartment"] != assignment["slot"]["compartment"]
                ):
                    continue
                exact = index
                break
            if exact >= 0:
                assignments[exact]["event"] = event
                assignments[exact]["delta_min"] = event["minutes"] - assignments[exact]["slot"]["minutes"]
                continue
        pending.append(event)

    for event in pending:
        best = -1
        best_distance = float("inf")
        for index, assignment in enumerate(assignments):
            if assignment["event"]:
                continue
            if (
                event["compartment"]
                and assignment["slot"]["compartment"]
                and event["compartment"] != assignment["slot"]["compartment"]
            ):
                continue
            distance = abs(event["minutes"] - assignment["slot"]["minutes"])
            if distance < best_distance:
                best_distance = distance
                best = index
        if best >= 0:
            assignments[best]["event"] = event
            assignments[best]["delta_min"] = event["minutes"] - assignments[best]["slot"]["minutes"]
        else:
            extra.append(event)

    for assignment in assignments:
        assignment["on_time"] = (
            assignment["event"] is not None
            and assignment["delta_min"] is not None
            and abs(assignment["delta_min"]) <= TIMING_WINDOW_MIN
        )
    return {"assignments": assignments, "extra": extra}


def _pct(numerator: int, denominator: int) -> float | None:
    if not denominator:
        return None
    return min((numerator / denominator) * 100.0, 100.0)


def build_daily_rows(
    history: dict,
    schedules: dict,
    from_key: str,
    to_key: str,
    now_minutes: int | None = None,
) -> list[dict]:
    events, duplicates_removed = dedupe_actuations(normalise_history(history))
    prescribed = expand_prescribed(schedules, from_key, to_key)
    events_by_date: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        events_by_date[event["date_key"]].append(event)

    rows = []
    for key in sorted(prescribed):
        slots = prescribed[key]
        matched = match_day(slots, events_by_date.get(key, []))
        assignments = matched["assignments"]
        if key == to_key and now_minutes is not None:
            assignments = [
                a for a in assignments if a["event"] is not None or a["slot"]["minutes"] <= now_minutes
            ]
        taken = sum(1 for a in assignments if a["event"] is not None)
        on_time = sum(1 for a in assignments if a["on_time"])
        prescribed_count = len(assignments)
        rows.append(
            {
                "date": key,
                "weekday": _weekday_sunday_zero(parse_date_key(key)),
                "P": prescribed_count,
                "N": taken,
                "N_on_time": on_time,
                "extra": len(matched["extra"]),
                "correct_day": prescribed_count > 0 and taken == prescribed_count,
                "taking_pct": _pct(taken, prescribed_count),
                "timing_pct": _pct(on_time, prescribed_count),
                "assignments": assignments,
            }
        )
    return rows


def _non_adherent(assignment: dict) -> bool:
    if assignment["event"] is None:
        return True
    return abs(assignment["delta_min"]) > TIMING_WINDOW_MIN


def _prior_stats(prior_rows: list[dict]) -> dict:
    taking_rows = [r for r in prior_rows if r["P"] > 0]
    last7 = taking_rows[-7:]
    last14 = taking_rows[-14:]
    last30 = taking_rows[-30:]
    roll7 = (
        statistics.mean(r["taking_pct"] for r in last7) if last7 else DEFAULT_TAKING
    )
    roll14 = (
        statistics.mean(r["taking_pct"] for r in last14) if last14 else DEFAULT_TAKING
    )
    roll30 = (
        statistics.mean(r["taking_pct"] for r in last30) if last30 else DEFAULT_TAKING
    )

    streak = 0
    for row in reversed(prior_rows):
        stop = False
        for assignment in reversed(row["assignments"]):
            if _non_adherent(assignment):
                streak += 1
            else:
                stop = True
                break
        if stop:
            break

    deltas = []
    for row in prior_rows[-7:]:
        for assignment in row["assignments"]:
            if assignment["event"] is not None and assignment["delta_min"] is not None:
                deltas.append(assignment["delta_min"])
    median_lateness = statistics.median(deltas) if deltas else DEFAULT_MEDIAN_LATENESS

    return {
        "roll7_taking": float(roll7),
        "roll14_taking": float(roll14),
        "roll30_taking": float(roll30),
        "miss_streak": float(min(streak, MAX_STREAK)),
        "median_lateness_7d": float(median_lateness),
    }


def _days_since_miss(prior_rows: list[dict], target_day: date) -> float:
    miss_days = [
        parse_date_key(row["date"])
        for row in prior_rows
        if any(_non_adherent(assignment) for assignment in row["assignments"])
    ]
    if not miss_days:
        return float(DEFAULT_DAYS_SINCE_MISS)
    return float(min((target_day - max(miss_days)).days, DEFAULT_DAYS_SINCE_MISS))


def _slot_stats(prior_rows: list[dict], slot: dict, target_weekday: int) -> dict:
    slot_rows = prior_rows[-14:]
    slot_assignments = [
        assignment
        for row in slot_rows
        for assignment in row["assignments"]
        if assignment["slot"]["minutes"] == slot["minutes"]
    ]
    if slot_assignments:
        slot_miss_rate = 100.0 * sum(1 for a in slot_assignments if _non_adherent(a)) / len(slot_assignments)
    else:
        slot_miss_rate = 30.0

    weekday_assignments = [
        assignment
        for row in prior_rows[-28:]
        if parse_date_key(row["date"]).weekday() == (target_weekday - 1) % 7
        for assignment in row["assignments"]
    ]
    if weekday_assignments:
        weekday_miss_rate = 100.0 * sum(1 for a in weekday_assignments if _non_adherent(a)) / len(weekday_assignments)
    else:
        weekday_miss_rate = 30.0

    last_assignment = None
    for row in reversed(prior_rows):
        if row["assignments"]:
            last_assignment = row["assignments"][-1]
            break
    last_outcome = 1.0 if last_assignment is not None and _non_adherent(last_assignment) else 0.0

    slot_deltas = [
        assignment["delta_min"]
        for assignment in slot_assignments
        if assignment["event"] is not None and assignment["delta_min"] is not None
    ]
    slot_median_delay = float(statistics.median(slot_deltas)) if slot_deltas else 0.0

    return {
        "slot_miss_rate_14d": float(slot_miss_rate),
        "weekday_miss_rate_28d": float(weekday_miss_rate),
        "last_outcome": float(last_outcome),
        "slot_median_delay_14d": float(slot_median_delay),
    }


def _feature_dict(slot: dict, slot_index: int, day: date, stats: dict, days_since_miss: float,
                  slot_stats: dict) -> dict:
    hour = slot["minutes"] / 60.0
    weekday = _weekday_sunday_zero(day)
    return {
        "hour_sin": math.sin(2 * math.pi * hour / 24.0),
        "hour_cos": math.cos(2 * math.pi * hour / 24.0),
        "weekday_sin": math.sin(2 * math.pi * weekday / 7.0),
        "weekday_cos": math.cos(2 * math.pi * weekday / 7.0),
        "is_weekend": 1.0 if weekday in (0, 6) else 0.0,
        "compartment": float(slot["compartment"]) if slot["compartment"] not in (None, "") else 1.0,
        "slot_index": float(slot_index),
        "roll7_taking": stats["roll7_taking"],
        "roll14_taking": stats["roll14_taking"],
        "roll30_taking": stats["roll30_taking"],
        "miss_streak": stats["miss_streak"],
        "median_lateness_7d": stats["median_lateness_7d"],
        "days_since_last_miss": float(days_since_miss),
        "slot_miss_rate_14d": slot_stats["slot_miss_rate_14d"],
        "weekday_miss_rate_28d": slot_stats["weekday_miss_rate_28d"],
        "last_outcome": slot_stats["last_outcome"],
        "slot_median_delay_14d": slot_stats["slot_median_delay_14d"],
    }


def build_feature_rows(
    history: dict,
    schedules: dict,
    from_key: str,
    to_key: str,
    patient_id: str = "unknown",
    now_minutes: int | None = None,
) -> list[dict]:
    window_from = date_key(add_days(parse_date_key(from_key), -14))
    daily = build_daily_rows(history, schedules, window_from, to_key, now_minutes)
    rows_by_date = {row["date"]: row for row in daily}
    target_dates = sorted(key for key in rows_by_date if from_key <= key <= to_key)

    output = []
    for key in target_dates:
        day = parse_date_key(key)
        prior_rows = [rows_by_date[d] for d in sorted(rows_by_date) if d < key]
        stats = _prior_stats(prior_rows)
        days_since_miss = _days_since_miss(prior_rows, day)
        row = rows_by_date[key]
        for slot_index, assignment in enumerate(row["assignments"]):
            slot = assignment["slot"]
            slot_stats = _slot_stats(prior_rows, slot, row["weekday"])
            features = _feature_dict(slot, slot_index, day, stats, days_since_miss, slot_stats)
            label = 1 if _non_adherent(assignment) else 0
            output.append(
                {
                    "patient_id": patient_id,
                    "date": key,
                    "weekday": row["weekday"],
                    "slot_id": slot["id"],
                    "minutes": slot["minutes"],
                    "time": slot["time"],
                    "med_name": slot["med_name"],
                    "compartment": slot["compartment"],
                    "features": features,
                    "label": label,
                    "delta_min": assignment["delta_min"],
                }
            )
    return output


def dataset_feature_rows(
    dataset: dict,
    from_key: str | None = None,
    to_key: str | None = None,
    keep_simulated: bool = False,
) -> list[dict]:
    rows = []
    patients = (dataset or {}).get("patients", {})
    for patient_id, payload in patients.items():
        history = payload.get("history", {})
        schedules = payload.get("schedules", {})
        real_history = {
            key: event
            for key, event in history.items()
            if event and (keep_simulated or event.get("simulated") is not True)
        }
        if not real_history:
            continue
        dates = sorted(
            event["date"] for event in real_history.values() if event.get("date")
        )
        if not dates:
            continue
        start = from_key or dates[0]
        end = to_key or dates[-1]
        rows.extend(
            build_feature_rows(real_history, schedules, start, end, patient_id=patient_id)
        )
    return rows


def _parity_fixture() -> dict:
    schedules = {
        "s1": {"medName": "Metformin", "time": "08:00", "compartment": 1, "date": "2026-03-01", "frequency": "daily"},
        "s2": {"medName": "Amlodipine", "time": "20:00", "compartment": 2, "date": "2026-03-01", "frequency": "daily"},
    }
    history = {
        "e1": {"date": "2026-03-01", "time": "08:00", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e2": {"date": "2026-03-01", "time": "20:00", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
        "e3": {"date": "2026-03-02", "time": "08:05", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e4": {"date": "2026-03-02", "time": "20:00", "status": "Missed", "scheduledTime": "20:00", "compartment": 2},
        "e5": {"date": "2026-03-03", "time": "08:00", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e6": {"date": "2026-03-03", "time": "20:40", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
        "e7": {"date": "2026-03-04", "time": "08:00", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e8": {"date": "2026-03-04", "time": "20:00", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
        "e9": {"date": "2026-03-05", "time": "08:00", "status": "Missed", "scheduledTime": "08:00", "compartment": 1},
        "e10": {"date": "2026-03-05", "time": "20:00", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
        "e11": {"date": "2026-03-06", "time": "08:00", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e12": {"date": "2026-03-06", "time": "20:00", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
        "e13": {"date": "2026-03-07", "time": "08:00", "status": "Taken", "scheduledTime": "08:00", "compartment": 1},
        "e14": {"date": "2026-03-07", "time": "20:00", "status": "Taken", "scheduledTime": "20:00", "compartment": 2},
    }
    rows = build_feature_rows(history, schedules, "2026-03-08", "2026-03-08")
    return {
        "schedules": schedules,
        "history": history,
        "expected": [
            {
                "date": row["date"],
                "minutes": row["minutes"],
                "compartment": row["compartment"],
                "features": row["features"],
                "label": row["label"],
            }
            for row in rows
        ],
    }


if __name__ == "__main__":
    print(json.dumps(_parity_fixture(), indent=2))
