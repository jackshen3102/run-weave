"""Read a frozen, authenticated ScreenJournal export; never open the media store."""
import datetime as dt
import hashlib
import json
import subprocess
from zoneinfo import ZoneInfo
from job_state import Failure, digest, read, require, stamp, window


def source_scope(c):
    return "screen:" + c["producerId"] + ":" + c["sources"]["screen"]["expectedDeviceID"] + ":observed"


def rows(bundle, day, c):
    manifest = read(bundle / "manifest.json")
    raw = (bundle / "export.json").read_bytes()
    require(len(raw) <= 8 * 1024 * 1024 and hashlib.sha256(raw).hexdigest() == manifest["sha256"], "SCREEN_EXPORT_CHANGED")
    value = json.loads(raw)
    require(value["schemaVersion"] == 1 and value["deviceID"] == c["sources"]["screen"]["expectedDeviceID"] and value["day"] == day and value["timeZone"] == "Asia/Shanghai", "SCREEN_IDENTITY_MISMATCH")
    require(value["revision"] == manifest["revision"] and value["snapshotID"] == manifest["snapshotID"] and not value.get("nextCursor"), "SCREEN_SNAPSHOT_INCOMPLETE")
    canonical = dict(value, contentHash="")
    expected_hash = hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    require(value.get("contentHash") == expected_hash, "SCREEN_CONTENT_HASH_MISMATCH")
    require(value["coverage"] in ("complete", "partial", "unavailable"), "SCREEN_COVERAGE_INVALID")
    result, seen = [], set()
    for card in value["cards"]:
        require(card["cardID"] not in seen and isinstance(card["revision"], int) and card["revision"] > 0, "SCREEN_CARD_IDENTITY_INVALID")
        seen.add(card["cardID"])
        require(card["evidenceIDs"] and card["spans"], "SCREEN_EVIDENCE_REQUIRED")
        for span in card["spans"]:
            for ms in (span["startMs"], span["endMs"]):
                require(dt.datetime.fromtimestamp(ms / 1000, ZoneInfo("Asia/Shanghai")).date().isoformat() == day, "SCREEN_DAY_MISMATCH")
        # Only facts and stable IDs cross the publish boundary. No JPEG, path,
        # transient view ID or raw thread transcript is a source reference.
        ref = {"channel": "screen-timeline", "sourceScope": source_scope(c), "nativeId": card["cardID"], "revision": str(card["revision"]), "hash": digest(card)}
        result.append({"id": "screen:" + value["deviceID"] + ":" + card["cardID"], "day": day, "role": "observation", "text": json.dumps(card, ensure_ascii=False),
                       "anchor": source_scope(c) + ":" + card["matterID"], "project": None, "ref": ref})
    receipt = {"sourceScope": source_scope(c), "status": value["coverage"], "collectedAt": stamp(), **window(day)}
    return result, receipt, value["revision"]


def unavailable(day, c):
    return {"sourceScope": source_scope(c), "status": "unavailable", "collectedAt": stamp(), **window(day)}


def export(c, day, bundle=None):
    argv = c["sources"]["screen"]["exporterArgv"] + ["--day", day, "--json"]
    if bundle is not None:
        argv += ["--out", str(bundle)]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=120 if bundle is not None else 10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        require(False, "SCREEN_EXPORT_UNAVAILABLE")
    require(result.returncode == 0 and len(result.stdout.encode()) <= 8 * 1024 * 1024, "SCREEN_EXPORT_UNAVAILABLE")
    return json.loads(result.stdout)


def reconcile_revisions(state):
    # Called only after the original active/pending package is resolved.
    today = dt.datetime.now(ZoneInfo("Asia/Shanghai")).date()
    screen = state.c["sources"].get("screen", {})
    if not screen.get("enabled"):
        return
    for offset in range(1, 8):
        day = (today - dt.timedelta(days=offset)).isoformat()
        old = state.data["days"].get(day)
        if old is None or day < screen["effectiveFrom"]:
            continue
        try:
            value = export(state.c, day)
            require(value["deviceID"] == screen["expectedDeviceID"] and value["day"] == day and value["schemaVersion"] == 1, "SCREEN_IDENTITY_MISMATCH")
            if old.get("screenRevision") != value["revision"]:
                old["complete"] = False
        except (OSError, ValueError, KeyError, subprocess.SubprocessError, Failure):
            old["complete"] = False
