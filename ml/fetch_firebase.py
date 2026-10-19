"""Fetch real SmartMed dose events from Firebase Realtime Database.

Signs in with the caregiver demo account (override with environment variables),
downloads history/schedules, drops records tagged simulated, and writes
ml/data/real_data.json in the same shape as the simulated dataset.

Environment overrides:
  SMARTMED_EMAIL, SMARTMED_PASSWORD, FIREBASE_API_KEY, FIREBASE_DB_URL
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_API_KEY = "AIzaSyDzGt90UApRGj30sj7tNqCAbsfZO2g6358"
DEFAULT_DB_URL = "https://smartmed-grp27-default-rtdb.asia-southeast1.firebasedatabase.app"


def post_json(url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str) -> dict | None:
    with urllib.request.urlopen(url, timeout=30) as response:
        text = response.read().decode("utf-8")
    if text == "null" or not text:
        return None
    return json.loads(text)


def sign_in(api_key: str, email: str, password: str) -> str:
    data = post_json(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={urllib.parse.quote(api_key)}",
        {"email": email, "password": password, "returnSecureToken": True},
    )
    if "idToken" not in data:
        raise RuntimeError(f"Sign-in failed: {data}")
    return data["idToken"]


def fetch(api_key: str, db_url: str, email: str, password: str) -> dict:
    token = sign_in(api_key, email, password)
    query = "?auth=" + urllib.parse.quote(token)
    history = get_json(f"{db_url.rstrip('/')}/history.json{query}") or {}
    schedules = get_json(f"{db_url.rstrip('/')}/schedules.json{query}") or {}

    patients = {}
    for patient_id in sorted(set(history) | set(schedules)):
        raw_history = history.get(patient_id) or {}
        real_history = {
            key: value
            for key, value in raw_history.items()
            if value and value.get("simulated") is not True
        }
        patients[patient_id] = {
            "schedules": schedules.get(patient_id) or {},
            "history": real_history,
        }
    return {
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "patients": patients,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "data" / "real_data.json")
    parser.add_argument("--email", default=os.environ.get("SMARTMED_EMAIL"))
    parser.add_argument("--password", default=os.environ.get("SMARTMED_PASSWORD"))
    parser.add_argument("--api-key", default=os.environ.get("FIREBASE_API_KEY", DEFAULT_API_KEY))
    parser.add_argument("--db-url", default=os.environ.get("FIREBASE_DB_URL", DEFAULT_DB_URL))
    args = parser.parse_args()

    if not args.email or not args.password:
        raise SystemExit(
            "Set SMARTMED_EMAIL and SMARTMED_PASSWORD (or pass --email/--password). "
            "Credentials are deliberately not stored in the repository."
        )

    try:
        dataset = fetch(args.api_key, args.db_url, args.email, args.password)
    except urllib.error.HTTPError as error:
        print(f"HTTP {error.code}: {error.read().decode('utf-8', errors='replace')}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"Fetch failed: {error}", file=sys.stderr)
        raise SystemExit(1)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(dataset, indent=2), encoding="utf-8")

    total = 0
    for patient_id, payload in dataset["patients"].items():
        count = len(payload["history"])
        total += count
        if count:
            print(f"  {patient_id}: {count} real events")
    print(f"Wrote {args.out} ({total} real events across {len(dataset['patients'])} patient(s))")


if __name__ == "__main__":
    main()
