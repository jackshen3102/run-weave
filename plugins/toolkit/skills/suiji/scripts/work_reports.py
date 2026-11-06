"""Prepare a seven-calendar-day report from the authoritative Suiji work feed."""
import datetime as dt
import json
from pathlib import Path
import time

import work_records

SHANGHAI = dt.timezone(dt.timedelta(hours=8))


def period(anchor=None, now=None):
    today = (now or dt.datetime.now(SHANGHAI)).astimezone(SHANGHAI).date()
    friday = dt.date.fromisoformat(anchor) if anchor else today - dt.timedelta(days=(today.weekday() - 4) % 7)
    if friday.weekday() != 4 or friday > today:
        raise ValueError("ANCHOR_MUST_BE_A_PAST_OR_CURRENT_FRIDAY")
    return {"from": (friday - dt.timedelta(days=7)).isoformat(), "to": (friday - dt.timedelta(days=1)).isoformat()}


def identity(client):
    return {"endpoint": client.base, **{k: client.config[k] for k in ("serverId", "ownerId")}}


def prepare(client, args, fail, write):
    window = period(args.anchor)
    deadline = time.monotonic() + int(args.wait_seconds)
    while True:
        feed = work_records.list_all(client, {**window, "view": "logs"}, fail)
        incomplete = [d for d in feed["days"] if d["coverage"] != "complete"]
        if not incomplete or time.monotonic() >= deadline:
            break
        time.sleep(min(30, max(0, deadline - time.monotonic())))
    sources = client.call("list_work_sources", window)
    existing = client.call("find_work_report", window)["report"]
    if existing and existing["manuallyEdited"]:
        raise fail("REPORT_MANUALLY_EDITED; preserve the existing report")
    payload = {**window, "basedOnFeedRevision": feed["feedRevision"],
               "sourceFacts": [{"id": f["id"], "version": f["version"]} for f in feed["items"]]}
    if existing:
        payload["expectedVersion"] = existing["version"]
    value = {"identity": identity(client), "payload": payload, "facts": feed["items"],
             "days": feed["days"], "sources": sources, "existingReport": existing,
             "incompleteDates": [d["date"] for d in incomplete]}
    root = Path(args.out)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    target = root / "prepared.json"
    write(target, json.dumps(value, ensure_ascii=False).encode())
    return {"prepared": str(target), **window, "factCount": len(feed["items"]),
            "complete": not incomplete, "incompleteDates": value["incompleteDates"],
            "instructions": "Read every fact, merge repeated matters across days and sources. Preserve outcome evidence and unresolved work. Save title/body JSON, then report-publish. Missing sources are not zero work."}


def publish(client, args, fail, read, write, run):
    prepared = json.loads(read(args.input))
    if prepared["identity"] != identity(client):
        raise fail("PREPARED_IDENTITY_MISMATCH")
    result = json.loads(read(args.file))
    if set(result) != {"title", "body"} or not all(isinstance(result[k], str) and result[k].strip() for k in result):
        raise fail("REPORT_TITLE_AND_BODY_REQUIRED")
    import uuid
    intent = {"identity": prepared["identity"], "operation": "publish_work_report",
              "arguments": {"idempotencyKey": str(uuid.uuid4()), "input": {**prepared["payload"], **result}},
              "receiptPath": str(Path(args.request).with_suffix(".receipt.json"))}
    write(args.request, json.dumps(intent, ensure_ascii=False).encode())
    return run(client, args.request, intent)


def verify(client, intent, result, fail):
    value = result.get("report", {})
    expected = intent["arguments"]["input"]
    if not value.get("id") or any(value.get(k) != expected[k] for k in ("from", "to", "title", "body", "sourceFacts")):
        raise fail("INVALID_REPORT_RESPONSE; original request retained")
    actual = client.call("get_work_report", {"reportId": value["id"]})["report"]
    if actual != value:
        raise fail("REPORT_READBACK_CHANGED; original request retained")
