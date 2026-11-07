"""Bind cross-channel candidate facts to collected, read evidence and stable keys."""
import copy
import json
from pathlib import Path
import uuid

from job_state import Failure, date, digest, read, require, scopes, window, write


def evidence(path, meta):
    value = read(path / "evidence.json")
    require(digest(value) == meta["evidenceHash"], "MATERIALS_CHANGED")
    require(all(m.get("ref", {}).get("channel") not in ("browser-visit", "suiji-material") and not any(m.get("ref", {}).get("sourceScope", "").startswith(p) for p in ("browser:", "materials:", "browse:")) for m in value), "BROWSING_INPUT_REJECTED: start a new work context")
    return value


def native_rows(bundle, c, day=None):
    manifest = read(bundle / "manifest.json")
    require(isinstance(manifest, dict), "INVALID_NATIVE_MANIFEST")
    require(manifest.get("schemaVersion") == 1 and manifest.get("machineId") == c["producerId"] and manifest.get("timeZone") == c["timeZone"], "NATIVE_COLLECTION_IDENTITY_CHANGED")
    require(manifest.get("from") == manifest.get("to") and (day is None or manifest["from"] == day), "NATIVE_COLLECTION_RANGE_CHANGED")
    require(isinstance(manifest.get("sources"), list) and all(isinstance(r, dict) and r.get("status") in ("complete", "partial", "unavailable") for r in manifest["sources"]), "INVALID_NATIVE_RECEIPTS")
    raw = (bundle / "materials.jsonl").read_bytes()
    import hashlib
    require(hashlib.sha256(raw).hexdigest() == manifest["materialsSha256"], "NATIVE_MATERIALS_CHANGED")
    result = []
    for line in raw.decode().splitlines():
        m = json.loads(line)
        require(m["day"] == manifest["from"], "NATIVE_DAY_MISMATCH")
        require(hashlib.sha256(m["text"].encode()).hexdigest() == m["textSha256"], "NATIVE_TEXT_CHANGED")
        scope = "agent:" + c["producerId"] + ":" + m["provider"]
        project = m.get("project", {})
        result.append({"id": "agent:" + m["id"], "day": m["day"], "role": m["role"], "text": m["text"],
                       "occurredAt": m["occurredAt"], "sourceVersion": m["textSha256"],
                       "anchor": scope + ":" + m["threadId"] + ":" + str(m.get("nativeId", m["locator"]["byteOffset"])),
                       "threadId": m["threadId"], "origin": m["origin"], "phase": m.get("phase"),
                       "project": c["projectAliases"].get(project.get("id"), project.get("name") if project.get("id") != "unclassified" else None),
                       "ref": {"channel": "local-agent", "sourceScope": scope, "nativeId": m["threadId"], "hash": m["textSha256"]}})
    receipts = [{"sourceScope": "agent:" + c["producerId"] + ":" + r["provider"], "status": r["status"],
                 "collectedAt": manifest["collectedAt"], **window(manifest["from"])} for r in manifest["sources"]]
    return result, receipts


def feishu_rows(bundle, day, c):
    manifest = read(bundle / "manifest.json")
    path = bundle / "messages.json"
    rows = read(path) if path.exists() else []
    if rows:
        import hashlib
        require(hashlib.sha256(path.read_bytes()).hexdigest() == manifest["messagesSha256"], "FEISHU_MATERIALS_CHANGED")
    result = []
    scope = "feishu:" + c["sources"]["feishu"]["accountScope"] + ":messages"
    from feishu import stamp as message_stamp
    from zoneinfo import ZoneInfo
    for m in rows:
        when = message_stamp(m["create_time"], ZoneInfo("Asia/Shanghai")).astimezone(ZoneInfo("Asia/Shanghai"))
        occurred = when.date().isoformat()
        require(occurred == day, "FEISHU_DAY_MISMATCH")
        text = m.get("content", "")
        text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
        result.append({"id": "feishu:" + m["message_id"], "day": day, "role": "user", "text": text,
                       "occurredAt": when.isoformat(),
                       "author": m.get("sender", {}).get("id"), "anchor": scope + ":" + m["message_id"], "project": None,
                       "ref": {"channel": "feishu-message", "sourceScope": scope, "nativeId": m["message_id"], "hash": digest({"id": m["message_id"], "author": m.get("sender", {}).get("id"), "text": text, "day": occurred})}})
        result[-1]["sourceVersion"] = result[-1]["ref"]["hash"]
    receipt = {"sourceScope": scope, "status": "complete" if manifest["status"] == "complete" else "partial",
               "collectedAt": manifest["collectedAt"], **window(day)}
    return result, receipt, manifest.get("identity")


def validate(path, meta, candidate_path, state, work_records):
    require(meta["phase"] not in ("pending", "confirmed"), "BATCH_FROZEN")
    materials = evidence(path, meta)
    candidates = read(candidate_path)
    require(isinstance(candidates, dict) and set(candidates) >= {"batchId", "generation", "evidenceHash", "days"} and not set(candidates) - {"batchId", "generation", "evidenceHash", "days", "materialReviews"}, "INVALID_FACTS_FIELDS")
    require(candidates["batchId"] == meta["id"] and candidates["generation"] == meta["generation"] and candidates["evidenceHash"] == meta["evidenceHash"], "FACTS_BATCH_CHANGED")
    require([d["date"] for d in candidates["days"]] == meta["days"], "FACT_DAYS_MISMATCH")
    by_id = {m["id"]: m for m in materials}
    read_ids = meta.get("read", {})
    require(all(read_ids.get(m["id"], 0) >= len(m["text"]) for m in materials if m["role"] != "tool"), "UNREAD_MESSAGES: use job read, including all continuation chunks")
    identities = copy.deepcopy(state.data["identities"])
    exported = []
    for day in candidates["days"]:
        require(set(day) == {"date", "items"} and isinstance(day["items"], list), "INVALID_FACT_DAY")
        date(day["date"])
        facts, used = [], set()
        for item in day["items"]:
            require(isinstance(item, dict) and set(item) >= {"title", "statement", "status", "project", "sourceIds"} and not set(item) - {"title", "statement", "status", "project", "sourceIds", "eventKey"}, "INVALID_CANDIDATE_FIELDS")
            ids = item["sourceIds"]
            require(isinstance(ids, list) and ids and len(set(ids)) == len(ids) and all(i in by_id for i in ids), "INVALID_SOURCE_IDS")
            sources = [by_id[i] for i in ids]
            require(all(m["day"] == day["date"] for m in sources), "FACT_DAY_MISMATCH")
            require(all(read_ids.get(m["id"], 0) >= len(m["text"]) for m in sources), "UNREAD_FACT_SOURCE")
            if all(m["ref"]["channel"] == "screen-timeline" for m in sources):
                require(item["status"] in ("documented", "discussed"), "SCREEN_ONLY_IS_OBSERVATION")
            if item["status"] == "verified":
                require(any(m["role"] == "tool" and m["ref"]["channel"] == "local-agent" for m in sources), "VERIFIED_REQUIRES_TOOL_RECEIPT")
            projects = {m["project"] for m in sources if m["ref"]["channel"] == "local-agent"}
            if projects:
                expected = next(iter(projects)) if len(projects) == 1 else None
                require(item["project"] == expected, "PROJECT_SOURCE_MISMATCH")
            anchors = {m["anchor"] for m in sources}
            matching = {key for key, old in identities.items() if old["date"] == day["date"] and anchors.intersection(old["anchors"])}
            if item.get("eventKey"):
                matching.update(k for k, old in identities.items() if old["date"] == day["date"] and old["eventKey"] == item["eventKey"])
            require(len(matching) <= 1, "AMBIGUOUS_FACT_MERGE")
            key = next(iter(matching)) if matching else str(uuid.uuid4())
            require(key not in used, "AMBIGUOUS_FACT_SPLIT")
            used.add(key)
            old = identities.get(key)
            event = old["eventKey"] if old else item.get("eventKey") or str(uuid.uuid4())
            require(not item.get("eventKey") or item["eventKey"] == event, "EVENT_IDENTITY_CHANGED")
            identities[key] = {"date": day["date"], "eventKey": event, "externalKey": old["externalKey"] if old else str(uuid.uuid4()), "anchors": sorted(anchors | set(old["anchors"] if old else []))}
            refs = {digest(m["ref"]): m["ref"] for m in sources}
            facts.append({k: item[k] for k in ("title", "statement", "status", "project")} | {"eventKey": event, "externalKey": identities[key]["externalKey"], "sourceRefs": list(refs.values())})
        old_keys = {k for k, v in state.data["identities"].items() if v["date"] == day["date"]}
        # An omission cannot silently leave an earlier, now contradictory fact behind.
        require(not all(r["status"] == "complete" for r in meta["receipts"][day["date"]]) or old_keys <= used, "OMITTED_PRIOR_FACT: preserve or explicitly resolve existing fact identities")
        receipts = meta["receipts"][day["date"]]
        exported.append({"date": day["date"], "requestedScopes": scopes(state.c, day["date"]), "receipts": receipts, "facts": facts})
    payload = {"schemaVersion": 1, "sourceNamespace": state.c["sourceNamespace"], "sourceCollectedAt": max(r["collectedAt"] for d in exported for r in d["receipts"]), "days": exported}
    require(not candidates.get("materialReviews"), "BROWSING_IS_NOT_WORK")
    work_records.validate(payload, Failure, enforce_limits=False)
    for day in exported:
        single = {**payload, "days": [day], "sourceCollectedAt": max(r["collectedAt"] for r in day["receipts"])}
        if "materialResults" in payload:
            single["materialResults"] = [r for r in payload["materialResults"] if meta["materialDates"][r["recordId"]] == day["date"]]
        work_records.validate(single, Failure)
    write(path / "export.json", payload)
    state.data["identities"] = identities
    meta.update(phase="validated", exportHash=digest(payload), identitySnapshot=identities)
    return {"valid": True, "facts": sum(len(d["facts"]) for d in exported), "export": str(path / "export.json")}
