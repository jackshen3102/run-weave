"""Count recorded outcomes for two equal windows around a rollout, retaining evidence IDs."""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import sys


def instant(value):
    if not isinstance(value, str):
        raise ValueError("Expected an ISO timestamp with a timezone")
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.utcoffset() is None:
        raise ValueError(f"Timestamp needs a timezone: {value}")
    return timestamp.astimezone(timezone.utc)


def scheduled_events(database, task_id):
    uri = database.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        task = connection.execute("SELECT id FROM scheduled_tasks WHERE id = ?", (task_id,)).fetchone()
        if task is None:
            raise ValueError(f"Unknown scheduled task: {task_id}")
        # Keep all outcomes, including unfinished runs and human takeover.
        rows = connection.execute(
            """SELECT id, scheduled_for, status, payload_json FROM scheduled_runs
               WHERE task_id = ? AND trigger_kind = 'scheduled' ORDER BY scheduled_for, id""",
            (task_id,),
        )
        for run_id, scheduled_for, status, payload in rows:
            run = json.loads(payload)
            yield {
                "id": run_id,
                "at": scheduled_for,
                "outcome": run.get("outcome"),
                "evidence": run_id,
                "threadId": (run.get("threadRef") or {}).get("threadId"),
                "taskRevision": run.get("taskRevision"),
                "status": status,
                "errorCode": (run.get("error") or {}).get("code"),
                "startedAt": run.get("startedAt"),
                "finishedAt": run.get("finishedAt"),
            }
    finally:
        connection.close()


def exported_events(path):
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if line.strip():
                try:
                    yield json.loads(line)
                except ValueError as exc:
                    raise ValueError(f"{path}:{line_number}: {exc}") from exc


def summarize(records):
    outcomes = Counter(row.get("outcome") for row in records)
    missing = outcomes.pop(None, 0)
    return {
        "observations": len(records),
        "outcomes": dict(outcomes),
        "missingOutcome": missing,
        "records": records,
    }


def compare(events, cutover, days):
    if days <= 0:
        raise ValueError("--days must be positive")
    span = timedelta(days=days)
    start, end = cutover - span, cutover + span
    before, after, overlaps = [], [], []
    seen = set()
    for row in events:
        if not isinstance(row, dict):
            raise ValueError("Each event must be an object")
        at = instant(row.get("at"))
        if not start <= at < end:
            continue
        for key in ("id", "evidence"):
            if not isinstance(row.get(key), str) or not row[key].strip():
                raise ValueError(f"Missing {key} at {at}")
        if row["id"] in seen:
            raise ValueError(f"Duplicate observation: {row['id']}")
        seen.add(row["id"])
        outcome = row.get("outcome")
        if outcome is not None and not (isinstance(outcome, str) and outcome.strip()):
            raise ValueError(f"Invalid outcome for {row['id']}")
        if at >= cutover:
            after.append(row)
        elif any(instant(row[key]) >= cutover for key in ("startedAt", "finishedAt") if row.get(key)):
            overlaps.append(row)
        else:
            before.append(row)
    return {
        "startInclusive": start.isoformat(), "cutover": cutover.isoformat(), "endExclusive": end.isoformat(),
        "before": summarize(before), "after": summarize(after), "crossedCutover": overlaps,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--scheduled-db", type=Path, help="Runweave scheduled-tasks.sqlite (read-only)")
    source.add_argument("--events", type=Path, help="Outcome events exported as JSONL")
    parser.add_argument("--task-id", help="Runweave task ID; counts automatic runs only")
    parser.add_argument("--cutover", required=True, help="Observed rollout timestamp with timezone")
    parser.add_argument("--days", type=int, required=True, help="Length of each window")
    args = parser.parse_args()
    if bool(args.scheduled_db) != bool(args.task_id):
        parser.error("--scheduled-db and --task-id must be used together")
    try:
        events = scheduled_events(args.scheduled_db, args.task_id) if args.scheduled_db else exported_events(args.events)
        result = compare(events, instant(args.cutover), args.days)
    except (ValueError, OSError, OverflowError, sqlite3.Error) as exc:
        parser.exit(1, f"{exc}\n")
    result["source"] = str(args.scheduled_db or args.events)
    if args.task_id:
        result["taskId"] = args.task_id
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
