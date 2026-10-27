"""Read-only browser adapter: merge page visits locally, publish concise themes."""
import datetime as dt
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from job_state import digest, read, require, stamp, window


MAX_THEMES = 3
MAX_THEME_CHARS = 160


def source_scope(c):
    return "browser:" + c["producerId"] + ":observed"


def rows(bundle, day, c):
    manifest = read(bundle / "manifest.json")
    raw = (bundle / "visits.jsonl").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == manifest["materialsSha256"], "BROWSER_MATERIALS_CHANGED")
    require(manifest["schemaVersion"] == 1 and manifest["coverage"] == "observed-only" and manifest["from"] == day and manifest["to"] == day and manifest["timeZone"] == c["timeZone"], "INVALID_BROWSER_MANIFEST")
    require(Path(manifest["sourceRoot"]).resolve() == Path(c["sources"]["browser"]["root"]).resolve(), "BROWSER_ROOT_CHANGED")
    expected = set(c["sources"]["browser"]["expectedSourceIds"])
    receipts = manifest["receipts"]
    require({r["sourceId"] for r in receipts} == expected and len(receipts) == len(expected), "BROWSER_SOURCE_SET_CHANGED")
    require(all(r["readStatus"] in ("complete", "partial", "unavailable") for r in receipts), "INVALID_BROWSER_RECEIPTS")
    groups, identities = {}, set()
    for line in raw.decode().splitlines():
        material = json.loads(line)
        visit = material["visit"]
        require(visit["sourceId"] in expected and material["id"] == visit["sourceId"] + ":" + visit["visitId"] and material["id"] not in identities, "INVALID_BROWSER_IDENTITY")
        identities.add(material["id"])
        require(visit["schemaVersion"] == 1 and visit["actor"] == "unknown", "INVALID_BROWSER_OBSERVATION")
        url = urlsplit(visit["url"])
        require(url.scheme in ("http", "https") and not (url.query or url.fragment or url.username or url.password), "UNSAFE_BROWSER_URL")
        occurred = dt.datetime.fromisoformat(visit["visitedAt"].replace("Z", "+00:00"))
        require(occurred.tzinfo and occurred.astimezone(ZoneInfo(c["timeZone"])).date().isoformat() == day, "BROWSER_DAY_MISMATCH")
        groups.setdefault(visit["url"], []).append(material)
    result = []
    for url, visits in sorted(groups.items()):
        visits.sort(key=lambda m: m["id"])
        page_key = hashlib.sha256(url.encode()).hexdigest()
        titles = sorted({m["visit"]["title"] for m in visits if m["visit"]["title"]})
        text = json.dumps({"url": url, "titles": titles, "browsers": sorted({m["visit"]["browser"] for m in visits}), "visits": len(visits), "actor": "unknown", "coverage": "observed-only"}, ensure_ascii=False)
        ref = {"channel": "browser-visit", "sourceScope": source_scope(c), "nativeId": "page:" + page_key, "hash": digest([m["visit"] for m in visits])}
        result.append({"id": "browser:" + day + ":" + page_key, "day": day, "role": "observation", "text": text,
                       "anchor": source_scope(c) + ":" + day + ":" + page_key, "project": None,
                       "ref": ref, "browserBundle": str(bundle), "browserVisits": visits})
    statuses = [r["readStatus"] for r in receipts]
    status = "complete" if all(s == "complete" for s in statuses) else "unavailable" if all(s == "unavailable" for s in statuses) else "partial"
    if result and status == "unavailable":
        status = "partial"
    receipt = {"sourceScope": source_scope(c), "status": status, "collectedAt": manifest["collectedAt"], **window(day)}
    return result, receipt


def unavailable(day, c):
    return {"sourceScope": source_scope(c), "status": "unavailable", "collectedAt": stamp(), **window(day)}


def compact_ref(materials):
    """One digest-backed reference per theme; every original visit stays local."""
    visits = sorted((v for m in materials for v in m["browserVisits"]), key=lambda v: v["id"])
    require(len({v["id"] for v in visits}) == len(visits), "DUPLICATE_BROWSER_VISITS")
    ref = {"channel": "browser-visit", "sourceScope": materials[0]["ref"]["sourceScope"],
           "nativeId": "visits:" + digest([v["id"] for v in visits]), "hash": digest([v["visit"] for v in visits])}
    return ref, {"materialIds": [m["id"] for m in materials], "visits": visits, "ref": ref}


def verify(material, c, command):
    for visit in material["browserVisits"]:
        response = command(c["sources"]["browser"]["collectorArgv"] + ["read", "--bundle", material["browserBundle"], "--id", visit["id"], "--verify-source"])
        value = json.loads(response.stdout)
        require(value.get("verifiedSource") is True and value["visit"] == visit["visit"] and value["locator"] == visit["locator"], "BROWSER_SOURCE_MISMATCH")
