"""Work-fact commands. Authentication and frozen-write transport stay in suiji.py."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

STATUSES = {"progress", "discussed", "documented", "attempted", "agent-reported", "verified"}
FIELDS = {"workDate", "title", "statement", "status", "project"}


def validate(payload, fail, enforce_limits=True):
    def require(ok, message):
        if not ok:
            raise fail(message)
    def exact(value, keys, optional=()):
        require(isinstance(value, dict) and not set(value) - set(keys) - set(optional) and set(keys) <= set(value), "INVALID_WORK_FIELDS")
    def text(value, maximum, blank=False):
        require(isinstance(value, str) and len(value) <= maximum and (blank or bool(value.strip())), "INVALID_WORK_TEXT")
        require(all(not (ord(c) < 32 and c not in "\t\r\n") and not 127 <= ord(c) <= 159 and not 0xD800 <= ord(c) <= 0xDFFF for c in value), "INVALID_WORK_UNICODE")
    def identity(value):
        text(value, 240)
        require(not value.startswith(("/", "~")) and not re.match(r"^[A-Za-z]:[\\/]", value) and not any(c in value for c in "\r\n\t"), "INVALID_STABLE_KEY")
    def scope(value):
        require(isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value)), "INVALID_SOURCE_SCOPE")
    def timestamp(value):
        require(isinstance(value, str) and bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", value)), "INVALID_SOURCE_TIME")
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    exact(payload, {"schemaVersion", "sourceNamespace", "sourceCollectedAt", "days"}, {"basedOnFeedRevision"})
    require(payload["schemaVersion"] == 1, "INVALID_WORK_SCHEMA")
    scope(payload["sourceNamespace"])
    if "basedOnFeedRevision" in payload:
        require(bool(re.fullmatch(r"0|[1-9][0-9]{0,18}", payload["basedOnFeedRevision"])), "INVALID_FEED_REVISION")
    require(isinstance(payload["days"], list) and 1 <= len(payload["days"]) <= 100, "INVALID_WORK_DAYS")
    dates, keys, times, count = set(), set(), [], 0
    for day in payload["days"]:
        exact(day, {"date", "requestedScopes", "receipts", "facts"})
        date = dt.date.fromisoformat(day["date"])
        require(date.isoformat() == day["date"] and day["date"] not in dates, "INVALID_WORK_DATE")
        dates.add(day["date"])
        requested = day["requestedScopes"]
        require(isinstance(requested, list) and 1 <= len(requested) <= 100 and len(set(requested)) == len(requested), "INVALID_REQUESTED_SCOPES")
        for s in requested:
            scope(s)
        receipts = {}
        require(isinstance(day["receipts"], list), "INVALID_RECEIPTS")
        for receipt in day["receipts"]:
            exact(receipt, {"sourceScope", "status", "collectedAt", "from", "to"})
            s = receipt["sourceScope"]
            require(s in requested and s not in receipts and receipt["status"] in {"complete", "partial", "unavailable"}, "INVALID_RECEIPT_SCOPE")
            start = dt.datetime.combine(date, dt.time(), dt.timezone(dt.timedelta(hours=8)))
            require(timestamp(receipt["from"]) == start and timestamp(receipt["to"]) == start + dt.timedelta(days=1), "INVALID_RECEIPT_WINDOW")
            times.append(timestamp(receipt["collectedAt"]))
            receipts[s] = receipt
        require(set(receipts) == set(requested), "MISSING_SOURCE_RECEIPT")
        require(isinstance(day["facts"], list), "INVALID_FACTS")
        for fact in day["facts"]:
            exact(fact, {"externalKey", "eventKey", "title", "statement", "status", "project", "sourceRefs"})
            for k in ("externalKey", "eventKey"):
                identity(fact[k])
            require(fact["externalKey"] not in keys, "DUPLICATE_EXTERNAL_KEY")
            keys.add(fact["externalKey"])
            require(isinstance(fact["title"], str), "INVALID_WORK_TITLE")
            fact["title"] = fact["title"].strip()
            text(fact["title"], 80)
            require(not any(c in fact["title"] for c in "\n\r\t"), "INVALID_TITLE")
            text(fact["statement"], 4000)
            require(fact["status"] in STATUSES, "INVALID_WORK_STATUS")
            if fact["project"] is not None:
                require(isinstance(fact["project"], str), "INVALID_PROJECT")
                fact["project"] = fact["project"].strip() or None
                if fact["project"] is not None:
                    text(fact["project"], 80)
                    require(not any(c in fact["project"] for c in "\n\r\t"), "INVALID_PROJECT")
            require(isinstance(fact["sourceRefs"], list) and 1 <= len(fact["sourceRefs"]) <= 100, "SOURCE_REQUIRED")
            if all(ref["channel"] == "screen-timeline" for ref in fact["sourceRefs"]):
                require(fact["status"] in {"documented", "discussed"}, "SCREEN_ONLY_IS_OBSERVATION")
            for ref in fact["sourceRefs"]:
                exact(ref, {"channel", "sourceScope", "nativeId"}, {"revision", "hash"})
                require(ref["channel"] in {"local-agent", "feishu-message", "feishu-document", "browser-visit", "screen-timeline"} and ref["sourceScope"] in receipts and receipts[ref["sourceScope"]]["status"] != "unavailable", "SOURCE_NOT_READ")
                for field in ("nativeId", "revision"):
                    if field in ref:
                        identity(ref[field])
                        require(not any(c in ref[field] for c in "/\\") and "://" not in ref[field], "NATIVE_ID_REQUIRED")
                require("hash" not in ref or bool(re.fullmatch(r"[a-fA-F0-9]{64}", ref["hash"])), "INVALID_SOURCE_HASH")
            count += 1
    require(timestamp(payload["sourceCollectedAt"]) == max(times), "SOURCE_TIME_MUST_MATCH_RECEIPTS")
    require(not enforce_limits or (count <= 100 and len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()) <= 200 * 1024), "WORK_PACKAGE_LIMIT: split whole days; prepare the next only after receipt confirmation")
    return payload


def list_all(client, filters, fail):
    items, days, cursor, revision = [], {}, None, None
    while True:
        page = client.call("list_work_facts", {**filters, **({"cursor": cursor} if cursor else {})})
        if revision is not None and page["feedRevision"] != revision:
            raise fail("WORK_FEED_CHANGED; discard this incomplete read and restart")
        revision = page["feedRevision"]
        items.extend(page["items"])
        days.update({day["date"]: day for day in page["days"]})
        next_cursor = page.get("nextCursor")
        if not next_cursor:
            return {"items": items, "days": sorted(days.values(), key=lambda d: d["date"], reverse=True), "nextCursor": None, "feedRevision": revision}
        if next_cursor == cursor:
            raise fail("INVALID_PAGINATION; incomplete read")
        cursor = next_cursor


def identity_key(namespace, external):
    return json.dumps([namespace, external], ensure_ascii=False, separators=(",", ":"))


def index_path(args):
    return Path(args.config).with_suffix(".work-identities.json")


def atomic_private(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".work-index-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare(client, args, fail, private_read, exclusive_write):
    payload = validate(json.loads(private_read(args.input)), fail, enforce_limits=False)
    original = payload
    kept = []
    for day in original["days"]:
        trial = {**original, "days": kept + [day]}
        trial["sourceCollectedAt"] = max((r["collectedAt"] for d in trial["days"] for r in d["receipts"]), key=lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00")))
        if sum(len(d["facts"]) for d in trial["days"]) > 100 or len(json.dumps(trial, ensure_ascii=False, separators=(",", ":")).encode()) > 200 * 1024:
            if not kept:
                raise fail("SINGLE_DAY_PACKAGE_LIMIT; refuse to truncate a day")
            break
        kept.append(day)
    payload = {**original, "days": kept, "sourceCollectedAt": max((r["collectedAt"] for d in kept for r in d["receipts"]), key=lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00")))}
    remaining = original["days"][len(kept):]
    validate(payload, fail)
    page = list_all(client, {}, fail)
    if payload.get("basedOnFeedRevision") not in (None, page["feedRevision"]):
        raise fail("WORK_FEED_CHANGED; review the current facts before preparing again")
    payload["basedOnFeedRevision"] = page["feedRevision"]
    identity = {"endpoint": client.base, "serverId": client.config["serverId"], "ownerId": client.config["ownerId"]}
    path = index_path(args)
    index = json.loads(private_read(path)) if path.exists() else {"identity": identity, "keys": {}}
    if index["identity"] != identity:
        raise fail("INDEX_IDENTITY_MISMATCH")
    previews = []
    by_id = {f["id"]: f for f in page["items"]}
    for day in payload["days"]:
        for f in day["facts"]:
            key = identity_key(payload["sourceNamespace"], f["externalKey"])
            old = index["keys"].get(key)
            if old is None and index.get("schemaVersion", 1) == 1:
                old = index["keys"].get(payload["sourceNamespace"] + ":" + f["externalKey"])
            if old and old["eventKey"] != f["eventKey"]:
                raise fail("STABLE_EVENT_IDENTITY_CHANGED")
            index["keys"][key] = {**(old or {}), "eventKey": f["eventKey"], "sourceNamespace": payload["sourceNamespace"], "externalKey": f["externalKey"]}
            current = by_id.get((old or {}).get("id"))
            previews.append({"date": day["date"], "externalKey": f["externalKey"], "title": f["title"], "status": f["status"], "manualFields": current["manualFields"] if current else [], "current": current})
    atomic_private(path, json.dumps(index, ensure_ascii=False).encode())
    out = Path(args.out)
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    frozen = {"identity": identity, "payload": payload, "indexPath": str(path.resolve())}
    if remaining:
        remainder = {k: v for k, v in original.items() if k != "basedOnFeedRevision"}
        remainder["days"] = remaining
        remainder["sourceCollectedAt"] = max((r["collectedAt"] for d in remaining for r in d["receipts"]), key=lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00")))
        exclusive_write(out / "remaining.json", json.dumps(remainder, ensure_ascii=False).encode())
    exclusive_write(out / "prepared.json", json.dumps(frozen, ensure_ascii=False).encode())
    exclusive_write(out / "preview.json", json.dumps({"feedRevision": page["feedRevision"], "facts": previews, "days": [{"date": d["date"], "count": len(d["facts"]), "receipts": d["receipts"]} for d in payload["days"]]}, ensure_ascii=False, indent=2).encode())
    return {"prepared": str(out / "prepared.json"), "preview": str(out / "preview.json"), "facts": len(previews), "feedRevision": page["feedRevision"], "writes": 0, "remainingDays": len(remaining), "next": "Only after confirming this receipt, prepare remaining.json" if remaining else None}


def verify_result(client, intent, result, fail):
    operation, args = intent["operation"], intent["arguments"]
    if operation == "import_work_facts":
        inputs = {f["externalKey"]: {**f, "workDate": d["date"]} for d in args["input"]["days"] for f in d["facts"]}
        facts = result.get("facts", [])
        if not result.get("importId") or len(facts) != len(inputs) or len({r["externalKey"] for r in facts}) != len(inputs):
            raise fail("INVALID_IMPORT_RECEIPT; original request retained")
        if sum(result.get(k, -1) for k in ("created", "updated", "unchanged")) != len(inputs):
            raise fail("INVALID_IMPORT_COUNTS; original request retained")
        for row in facts:
            expected = inputs.get(row["externalKey"])
            actual = row["fact"]
            if not expected or actual["id"] != row["id"] or actual["eventKey"] != expected["eventKey"] or actual["version"] != row["version"]:
                raise fail("INVALID_IMPORT_FACT_RECEIPT")
            if any(actual[field] != expected[field] for field in FIELDS - set(actual["manualFields"])):
                raise fail("IMPORT_EFFECTIVE_FIELDS_MISMATCH")
            current = client.call("get_work_fact", {"factId": row["id"]})["fact"]
            if current != actual:
                if current.get("id") != actual["id"] or current.get("eventKey") != actual["eventKey"] or current.get("version", 0) <= actual["version"]:
                    raise fail("IMPORT_READBACK_MISMATCH; original request retained")
                result.setdefault("changedSinceReceipt", []).append(row["id"])
    elif operation == "reclassify_work_facts":
        facts = result.get("facts", [])
        expected = {i["id"]: i for i in args["input"]["items"]}
        if {f["id"] for f in facts} != set(expected) or any(f["project"] != expected[f["id"]].get("project", args["input"].get("project")) or f["version"] != expected[f["id"]]["expectedVersion"] + 1 for f in facts):
            raise fail("INVALID_RECLASSIFICATION_RECEIPT")
        for fact in facts:
            if client.call("get_work_fact", {"factId": fact["id"]})["fact"] != fact:
                raise fail("RECLASSIFICATION_READBACK_CHANGED")
    return result


def reclassification(value, fail):
    if not isinstance(value, dict) or set(value) not in ({"items", "project"}, {"items"}):
        raise fail("INVALID_RECLASSIFICATION_FIELDS")
    if not isinstance(value["items"], list) or not 1 <= len(value["items"]) <= 100:
        raise fail("INVALID_RECLASSIFICATION_COUNT")
    def project(value):
        if value is None:
            return None
        if not isinstance(value, str):
            raise fail("INVALID_PROJECT")
        result = value.strip() or None
        if result is not None and (len(result) > 80 or any(ord(c) < 32 or 127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF for c in result)):
            raise fail("INVALID_PROJECT")
        return result
    seen = set()
    for item in value["items"]:
        fields = {"id", "expectedVersion"} | ({"project"} if "project" not in value else set())
        if not isinstance(item, dict) or set(item) != fields:
            raise fail("INVALID_RECLASSIFICATION_ITEM")
        if not isinstance(item["id"], str):
            raise fail("INVALID_FACT_ID")
        uuid.UUID(item["id"])
        if item["id"] in seen or type(item["expectedVersion"]) is not int or item["expectedVersion"] < 1:
            raise fail("INVALID_RECLASSIFICATION_VERSION_OR_DUPLICATE")
        seen.add(item["id"])
        if "project" in item:
            item["project"] = project(item["project"])
    if "project" in value:
        value["project"] = project(value["project"])
    return value


def recovery_intent(args, config, fail, private_read):
    """Opt-in automation is restricted to an already frozen work import."""
    job = json.loads(private_read(args.job_config))
    intent = json.loads(private_read(args.request))
    if job.get("suiji", {}).get("autoPublish") is not True:
        raise fail("AUTO_PUBLISH_DISABLED")
    if Path(job["suiji"]["configPath"]).resolve() != Path(args.config).resolve():
        raise fail("JOB_CONNECTION_MISMATCH")
    if intent.get("operation") != "import_work_facts":
        raise fail("WORK_IMPORT_ONLY")
    expected = {k: config[k] for k in ("serverId", "ownerId")}
    # endpoint normalization is done by the shared client before any write.
    if any(intent.get("identity", {}).get(k) != v for k, v in expected.items()):
        raise fail("REQUEST_IDENTITY_MISMATCH")
    payload = intent["arguments"]["input"]
    if payload.get("sourceNamespace") != job.get("sourceNamespace"):
        raise fail("JOB_SOURCE_MISMATCH")
    validate(payload, fail)
    local = job["sources"]["localAgent"]["providers"]
    allowed = {"agent:" + job["producerId"] + ":" + p for p in local}
    if job["sources"]["feishu"]["enabled"]:
        allowed.add("feishu:" + job["sources"]["feishu"]["accountScope"] + ":messages")
    browser = job["sources"].get("browser", {})
    screen = job["sources"].get("screen", {})
    for day in payload["days"]:
        expected = set(allowed)
        if browser.get("enabled") and day["date"] >= browser["effectiveFrom"]:
            expected.add("browser:" + job["producerId"] + ":observed")
        if screen.get("enabled") and day["date"] >= screen["effectiveFrom"]:
            expected.add("screen:" + job["producerId"] + ":" + screen["expectedDeviceID"] + ":observed")
        if set(day["requestedScopes"]) != expected:
            raise fail("JOB_SCOPE_MISMATCH")
    return intent


def reconcile(client, request, intent, fail, run_intent):
    import time
    for attempt in range(3):
        try:
            return run_intent(client, request, intent)
        except fail as error:
            # Explicit feed conflicts are terminal rejections, never unknown writes.
            if not any(str(error).startswith(code) for code in
                       ("NETWORK_RESULT_UNKNOWN", "DEPENDENCY_UNAVAILABLE", "HTTP_502", "HTTP_503", "HTTP_504")):
                raise
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
