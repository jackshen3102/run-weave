"""Credential-free source receipt shared by work and browsing collectors."""
import datetime as dt
import hashlib
import json


def receipt(domain, scope, start, end, effective_from, collected_at, status, items, errors=()):
    if domain not in ("work", "browse") or not isinstance(scope, str) or not scope:
        raise ValueError("INVALID_ADAPTER_SOURCE")
    if (domain == "work" and scope.startswith(("browse:", "browser:", "materials:"))) or (domain == "browse" and not scope.startswith("browse:")):
        raise ValueError("ADAPTER_DOMAIN_MISMATCH")
    if status not in ("complete", "partial", "unavailable"):
        raise ValueError("INVALID_ADAPTER_STATUS")
    if not isinstance(errors, (list, tuple)) or not all(isinstance(value, str) and value for value in errors) or (status == "complete" and errors):
        raise ValueError("INVALID_ADAPTER_ERRORS")
    begin, finish = (dt.datetime.fromisoformat(v.replace("Z", "+00:00")) for v in (start, end))
    captured = dt.datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
    if any(v.tzinfo is None for v in (begin, finish, captured)) or begin >= finish:
        raise ValueError("INVALID_ADAPTER_RANGE")
    expected_from = None
    if effective_from is not None:
        day = dt.date.fromisoformat(effective_from)
        if day.isoformat() != effective_from:
            raise ValueError("INVALID_ADAPTER_EFFECTIVE_DATE")
        joined = dt.datetime.combine(day, dt.time(), dt.timezone(dt.timedelta(hours=8)))
        if joined < finish:
            expected_from = max(begin, joined).isoformat()
    indexed = {}
    for item in items:
        if set(item) != {"id", "version", "occurredAt"} or not all(isinstance(item[k], str) and item[k] for k in item):
            raise ValueError("INVALID_ADAPTER_ITEM")
        occurred = dt.datetime.fromisoformat(item["occurredAt"].replace("Z", "+00:00"))
        if occurred.tzinfo is None or not begin <= occurred < finish:
            raise ValueError("ADAPTER_ITEM_OUTSIDE_RANGE")
        previous = indexed.get(item["id"])
        if previous is not None and previous != item:
            raise ValueError("ADAPTER_ITEM_VERSION_CONFLICT")
        indexed[item["id"]] = item
    ordered = sorted(indexed.values(), key=lambda value: value["id"])
    if status == "unavailable" and ordered:
        raise ValueError("UNAVAILABLE_ADAPTER_HAS_ITEMS")
    return {"schemaVersion": 1, "source": {"domain": domain, "scope": scope},
            "range": {"from": start, "to": end, "timeZone": "Asia/Shanghai", "effectiveFrom": effective_from,
                      "expectedFrom": expected_from, "beforeEnrollment": "unknown"},
            "status": status, "collectedAt": collected_at, "coverageMode": "recorded-only", "errors": list(errors),
            "items": ordered, "itemsRevision": hashlib.sha256(json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
