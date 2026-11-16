"""Read-only recent local-source reconciliation; successful publish owns checkpoints."""
import datetime as dt
import json
import subprocess
from job_state import Failure, date, require, stamp, today


def reconcile(state):
    c = state.c
    providers = c["sources"]["localAgent"]["providers"]
    start = max(date(c["startDate"]), today() - dt.timedelta(days=7))
    end = today() - dt.timedelta(days=1)
    days = [day for day, old in state.data["days"].items() if start <= date(day) <= end and old.get("complete")]
    if not providers or not days:
        return
    argv = c["collectorArgv"] + ["fingerprint", "--from", start.isoformat(), "--to", end.isoformat(),
            "--timezone", c["timeZone"], "--providers", ",".join(providers), "--machine-id", c["producerId"]]
    if c["sources"]["localAgent"].get("home"):
        argv += ["--home", c["sources"]["localAgent"]["home"]]
    for thread in state.data["excludedThreads"]:
        argv += ["--exclude-thread", thread]
    report = {"checkedAt": stamp(), "from": start.isoformat(), "to": end.isoformat(), "changedDays": []}
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=600, check=False)
        require(result.returncode in (0, 2) and len(result.stdout.encode()) <= 1024 * 1024, "LOCAL_LOOKBACK_UNAVAILABLE")
        value = json.loads(result.stdout)
        require(value["schemaVersion"] == 1 and value["machineId"] == c["producerId"] and value["timeZone"] == c["timeZone"]
                and value["from"] == start.isoformat() and value["to"] == end.isoformat(), "LOCAL_LOOKBACK_IDENTITY_CHANGED")
        fingerprints = {item["day"]: item["sources"] for item in value["days"]}
        for day in days:
            sources = fingerprints[day]
            require(len(sources) == len(providers) and {item["provider"] for item in sources} == set(providers), "LOCAL_LOOKBACK_INCOMPLETE")
            old = state.data["days"][day]
            for source in sources:
                scope = "agent:" + c["producerId"] + ":" + source["provider"]
                if source["status"] != "complete" or old.get("localFingerprints", {}).get(scope) != source["inputHash"]:
                    old["complete"] = False
                    report["changedDays"].append(day)
                    break
        report.update(status="checked", index=value.get("index"))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, Failure):
        # Keep the last successful hashes. Unavailability cannot confirm an empty day.
        for day in days:
            state.data["days"][day]["complete"] = False
        report["status"] = "unavailable"
    state.data["localLookback"] = report
