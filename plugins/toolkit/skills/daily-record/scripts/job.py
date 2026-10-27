#!/usr/bin/env python3
"""One local Daily Record workflow, reused by scheduled Agents on every machine."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

sys.dont_write_bytecode = True
from job_state import Failure, State, config, date, digest, directory, process_identity, read, require, scopes, stamp, window, write, browser_enabled, migrate_sources
import job_facts
import job_browser


def suiji_module():
    location = Path(__file__).resolve().parents[2] / "suiji" / "scripts"
    require((location / "suiji.py").is_file(), "SUIJI_SKILL_REQUIRED: install the matching suiji skill")
    sys.path.insert(0, str(location))
    import suiji
    return suiji


def command(argv, accepted=(0,)):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure("COLLECTOR_UNAVAILABLE_OR_TIMEOUT") from None
    require(result.returncode in accepted, "COLLECTION_FAILED: inspect the private source manifest")
    return result


def collect(state, path, meta):
    c = state.c
    rows, meta["receipts"], meta["sourceDirs"] = [], {}, {}
    for day in meta["days"]:
        day_root = directory(path / (day + "-g" + str(meta["generation"])))
        meta["sourceDirs"][day] = str(day_root)
        receipts = []
        local = c["sources"]["localAgent"]
        if local["providers"]:
            bundle = day_root / "agent"
            argv = c["collectorArgv"] + ["collect", "--from", day, "--to", day, "--timezone", c["timeZone"], "--out", str(bundle), "--providers", ",".join(local["providers"]), "--machine-id", c["producerId"]]
            if local.get("home"):
                argv += ["--home", local["home"]]
            for thread in state.data["excludedThreads"]:
                argv += ["--exclude-thread", thread]
            try:
                command(argv, (0, 2))
                material, actual = job_facts.native_rows(bundle, c)
                rows.extend(material)
                receipts.extend(actual)
            except Failure:
                receipts.extend({"sourceScope": "agent:" + c["producerId"] + ":" + p, "status": "unavailable", "collectedAt": stamp(), **window(day)} for p in local["providers"])
        if c["sources"]["feishu"]["enabled"]:
            bundle = day_root / "feishu"
            try:
                command([sys.executable, str(Path(__file__).with_name("feishu.py")), "discover", "--from", day, "--to", day, "--channels", "messages", "--timezone", c["timeZone"], "--out", str(bundle)], (0, 2))
                material, receipt, identity = job_facts.feishu_rows(bundle, day, c)
                require(identity and identity.get("openId"), "FEISHU_IDENTITY_UNAVAILABLE")
                previous = state.data.get("feishuIdentity")
                require(previous in (None, identity["openId"]), "FEISHU_IDENTITY_CHANGED")
                state.data["feishuIdentity"] = identity["openId"]
                rows.extend(material)
                receipts.append(receipt)
            except Failure as error:
                if str(error) == "FEISHU_IDENTITY_CHANGED":
                    raise
                receipts.append({"sourceScope": "feishu:" + c["sources"]["feishu"]["accountScope"] + ":messages", "status": "unavailable", "collectedAt": stamp(), **window(day)})
        if browser_enabled(c, day):
            bundle = day_root / "browser"
            browser = c["sources"]["browser"]
            argv = browser["collectorArgv"] + ["collect", "--root", browser["root"], "--from", day, "--to", day, "--timezone", c["timeZone"], "--out", str(bundle)]
            for source_id in browser["expectedSourceIds"]:
                argv += ["--source-id", source_id]
            try:
                command(argv, (0, 2))
                material, receipt = job_browser.rows(bundle, day, c)
                rows.extend(material)
                receipts.append(receipt)
            except (Failure, OSError, ValueError, KeyError):
                receipts.append(job_browser.unavailable(day, c))
        meta["receipts"][day] = receipts
    write(path / "evidence.json", rows)
    meta.update(phase="reviewed", evidenceHash=digest(rows), read={})
    template(path, meta)


def template(path, meta):
    write(path / "facts.template.json", {"batchId": meta["id"], "generation": meta["generation"], "evidenceHash": meta["evidenceHash"], "days": [{"date": d, "items": []} for d in meta["days"]]})


def prepare(state, args):
    require(args.run_id and args.thread_id and args.owner_pid and args.owner_pid > 1, "RUN_THREAD_AND_AGENT_PID_REQUIRED")
    owner = process_identity(args.owner_pid)
    require(owner, "OWNER_PROCESS_NOT_RUNNING")
    active = state.data.get("active")
    if active:
        path = Path(state.data["batches"][active]["path"])
        meta = read(path / "batch.json")
        # batch.json is the durable journal if a process exits before state.json commits.
        if meta.get("identitySnapshot") is not None:
            state.data["identities"] = meta["identitySnapshot"]
        state.data["days"].update(meta.get("confirmations", {}))
        if meta["phase"] == "confirmed":
            state.data["active"] = None
            return prepare(state, args)
        if meta["runId"] != args.run_id:
            require(not (process_identity(meta["ownerPid"]) == meta["ownerProcess"]), "BUSY: original Agent is still active")
            require(args.recover_run_id == meta["runId"], "EXPLICIT_RECOVERY_REQUIRED")
            meta.update(runId=args.run_id, generation=meta["generation"] + 1, ownerPid=args.owner_pid, ownerProcess=owner)
            if "evidenceHash" in meta:
                template(path, meta)
        else:
            require(meta["ownerPid"] == args.owner_pid and meta["ownerProcess"] == owner, "OWNER_PROCESS_CHANGED")
    else:
        days = state.missing()[:state.c["maxDaysPerRun"]]
        if days:
            days = [d for d in days if (date(d) - date(days[0])).days < 366]
        if not days:
            return {"complete": True, "remainingDays": []}
        batch = str(uuid.uuid4())
        path = directory(directory(state.root / "batches") / batch)
        meta = {"id": batch, "phase": "prepared", "days": days, "runId": args.run_id, "generation": 1,
                "ownerPid": args.owner_pid, "ownerProcess": owner, "sentDays": [], "pending": None}
        state.data["active"] = batch
    if args.recollect:
        require(not meta.get("pending") and not meta["sentDays"], "PUBLISHED_OR_PENDING_BATCH_CANNOT_BE_RECOLLECTED")
        meta.update(phase="prepared", generation=meta["generation"] + 1)
    if args.thread_id not in state.data["excludedThreads"]:
        state.data["excludedThreads"].append(args.thread_id)
    # Persist ownership before subprocess collection, including interruptions.
    state.save_batch(path, meta)
    write(state.file, state.data)
    if meta["phase"] in ("prepared", "collecting"):
        meta["phase"] = "collecting"
        state.save_batch(path, meta)
        try:
            collect(state, path, meta)
        except Exception:
            meta["phase"] = "collection-failed"
            state.save_batch(path, meta)
            raise
    require(meta["phase"] != "collection-failed", "COLLECTION_INTERRUPTED: recover with a new run and --recollect")
    state.save_batch(path, meta)
    return {"batch": str(path), "runId": meta["runId"], "generation": meta["generation"], "phase": meta["phase"],
            "template": str(path / "facts.template.json"), "receipts": meta.get("receipts"), "priorFacts": state.data["identities"],
            "next": "reconcile" if meta.get("pending") else "publish" if meta["phase"] in ("validated", "pending") else "review/read then validate/publish", "remainingDays": state.missing()}


def confirm(state, path, meta, suiji):
    pending = meta["pending"]
    request, receipt = Path(pending["request"]), Path(pending["receipt"])
    if request.exists():
        intent = read(request)
        require(digest(intent) == pending["hash"], "FROZEN_REQUEST_CHANGED")
        recovery_args = SimpleNamespace(job_config=state.config_path, request=str(request), config=state.c["suiji"]["configPath"])
        connection = json.loads(suiji.private_read(recovery_args.config))
        frozen = suiji.work_records.recovery_intent(recovery_args, connection, suiji.Failure, suiji.private_read)
        client, info = suiji.connect(connection, state.c["suiji"]["tokenFile"])
        require(info.get("features", {}).get("workRecords"), "WORK_RECORDS_UNAVAILABLE")
        try:
            suiji.work_records.reconcile(client, str(request), frozen, suiji.Failure, suiji.run_intent)
        except suiji.Failure as error:
            if str(error) == "WORK_FEED_CHANGED":
                os.rename(request, str(request) + ".rejected")
                meta["pending"] = None
                meta["phase"] = "validated"
                state.save_batch(path, meta)
            raise
    result = read(receipt)
    require(result.get("importId"), "INVALID_IMPORT_RECEIPT")
    # run_intent persisted this receipt only after its independent readback.
    for day in pending["days"]:
        state.data["days"][day] = {"complete": all(r["status"] == "complete" for r in meta["receipts"][day]), "receipts": meta["receipts"][day], "importId": result["importId"]}
        meta.setdefault("confirmations", {})[day] = state.data["days"][day]
        if day not in meta["sentDays"]:
            meta["sentDays"].append(day)
    meta["pending"] = None
    state.save_batch(path, meta)
    return result


def publish(state, path, meta):
    require(state.c["suiji"]["autoPublish"], "AUTO_PUBLISH_DISABLED")
    require(meta["phase"] in ("validated", "pending"), "VALIDATED_BATCH_REQUIRED")
    suiji = suiji_module()
    if meta.get("pending"):
        confirm(state, path, meta, suiji)
    payload = read(path / "export.json")
    require(digest(payload) == meta["exportHash"], "VALIDATED_EXPORT_CHANGED")
    connection = read(state.c["suiji"]["configPath"])
    client, info = suiji.connect(connection, state.c["suiji"]["tokenFile"])
    require(info.get("features", {}).get("workRecords"), "WORK_RECORDS_UNAVAILABLE")
    require(info.get("features", {}).get("workSources"), "WORK_SOURCES_UNAVAILABLE")
    if any(ref["channel"] == "browser-visit" for day in payload["days"] for fact in day["facts"] for ref in fact["sourceRefs"]) or any(s.startswith("browser:") for day in payload["days"] for s in day["requestedScopes"]):
        require(info.get("features", {}).get("workBrowserHistory"), "BROWSER_HISTORY_UNAVAILABLE")
    source_page = client.call("list_work_sources", {"from": meta["days"][0], "to": meta["days"][-1]})
    for day in meta["days"]:
        for scope in scopes(state.c, day):
            require(any(s["sourceScope"] == scope and s["sourceNamespace"] == state.c["sourceNamespace"] and s["producerId"] == state.c["producerId"] and s["effectiveFrom"] <= day and (not s["effectiveTo"] or s["effectiveTo"] > day) for s in source_page["items"]), "SOURCE_NOT_REGISTERED")
    conflicts = 0
    while len(meta["sentDays"]) < len(meta["days"]):
        remaining = {**payload, "days": [d for d in payload["days"] if d["date"] not in meta["sentDays"]]}
        remaining["sourceCollectedAt"] = max((r["collectedAt"] for d in remaining["days"] for r in d["receipts"]), key=lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00")))
        attempt = directory(path / ("publish-" + str(uuid.uuid4())))
        write(attempt / "input.json", remaining)
        args = SimpleNamespace(input=str(attempt / "input.json"), out=str(attempt / "prepared"), config=state.c["suiji"]["configPath"])
        prepared = suiji.work_records.prepare(client, args, suiji.Failure, suiji.private_read, suiji.exclusive_write)
        value = read(prepared["prepared"])
        receipt = attempt / "receipt.json"
        request = attempt / "request.json"
        intent = {"identity": value["identity"], "operation": "import_work_facts", "arguments": {"idempotencyKey": str(uuid.uuid4()), "input": value["payload"]}, "indexPath": value["indexPath"], "receiptPath": str(receipt)}
        suiji.exclusive_write(request, json.dumps(intent, ensure_ascii=False).encode())
        meta["pending"] = {"request": str(request), "receipt": str(receipt), "hash": digest(intent), "days": [d["date"] for d in value["payload"]["days"]]}
        meta["phase"] = "pending"
        state.save_batch(path, meta)
        write(state.file, state.data)
        try:
            confirm(state, path, meta, suiji)
        except suiji.Failure as error:
            if str(error) != "WORK_FEED_CHANGED":
                raise
            conflicts += 1
            if conflicts >= 3:
                raise
            time.sleep(conflicts)
    meta["phase"] = "confirmed"
    state.data["active"] = None
    state.save_batch(path, meta)
    return {"confirmedDays": meta["sentDays"], "remainingDays": state.missing(), "complete": not state.missing()}


def context(state, path, meta, args):
    require(meta["phase"] == "reviewed" and state.c["sources"]["feishu"]["enabled"], "CONTEXT_NOT_ALLOWED")
    require(args.date in meta["days"] and args.message_id, "CONTEXT_DAY_AND_SEED_REQUIRED")
    source_dir = Path(meta["sourceDirs"][args.date])
    bundle = source_dir / "feishu"
    out = source_dir / ("context-" + str(uuid.uuid4()))
    try:
        command([sys.executable, str(Path(__file__).with_name("feishu.py")), "context", "--bundle", str(bundle), "--message-id", args.message_id, "--minutes", str(args.minutes), "--out", str(out)])
        rows, receipt, identity = job_facts.feishu_rows(out, args.date, state.c)
        require(identity and identity["openId"] == state.data["feishuIdentity"], "FEISHU_IDENTITY_CHANGED")
    except Failure:
        for r in meta["receipts"][args.date]:
            if r["sourceScope"].startswith("feishu:"):
                r.update(status="partial", collectedAt=stamp())
        state.save_batch(path, meta)
        raise
    materials = job_facts.evidence(path, meta)
    previous = {m["id"]: m for m in materials}
    for row in rows:
        if row["id"] in previous:
            if previous[row["id"]] != row:
                for r in meta["receipts"][args.date]:
                    if r["sourceScope"].startswith("feishu:"):
                        r.update(status="partial", collectedAt=stamp())
                state.save_batch(path, meta)
                raise Failure("FEISHU_MESSAGE_CHANGED: recollect instead of mixing snapshots")
        else:
            materials.append(row)
    write(path / "evidence.json", materials)
    meta["evidenceHash"] = digest(materials)
    for r in meta["receipts"][args.date]:
        if r["sourceScope"] == receipt["sourceScope"]:
            r["collectedAt"] = receipt["collectedAt"]
    template(path, meta)
    state.save_batch(path, meta)
    return {"messages": len(rows), "template": str(path / "facts.template.json")}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "review", "read", "context", "validate", "publish", "reconcile", "status", "migrate-sources"])
    parser.add_argument("--config", required=True)
    for name in ("batch", "facts", "run-id", "thread-id", "recover-run-id", "id", "date", "message-id", "next-config"):
        parser.add_argument("--" + name)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-source", action="store_true")
    parser.add_argument("--recollect", action="store_true")
    parser.add_argument("--generation", type=int)
    parser.add_argument("--owner-pid", type=int)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--max-chars", type=int, default=8000)
    parser.add_argument("--minutes", type=int, default=30)
    args = parser.parse_args()
    c = config(args.config)
    if args.command == "status":
        file = Path(c["stateDir"]) / "state.json"
        stored = read(file) if file.exists() else {}
        return {"producerId": c["producerId"], "sources": scopes(c), "days": stored.get("days", {}), "active": stored.get("active"), "batches": stored.get("batches", {})}
    with State(c, migrating=args.command == "migrate-sources") as state:
        state.config_path = str(Path(args.config).resolve())
        if args.command == "migrate-sources":
            require(args.next_config, "NEXT_CONFIG_REQUIRED")
            return migrate_sources(state, args.config, args.next_config, args.dry_run)
        if args.command == "prepare":
            return prepare(state, args)
        require(args.batch and args.run_id and args.generation, "BATCH_OWNER_REQUIRED")
        path, meta = state.batch(args)
        if args.command == "context":
            return context(state, path, meta, args)
        if args.command in ("review", "read"):
            materials = job_facts.evidence(path, meta)
            require(args.offset >= 0 and 1 <= args.limit <= 100 and 1 <= args.max_chars <= 100000, "INVALID_READ_RANGE")
            if args.command == "review":
                selected = [m for m in materials if not args.date or m["day"] == args.date]
                return {"total": len(selected), "items": [{k: v for k, v in m.items() if k not in ("text", "browserVisits", "browserBundle")} | {"preview": m["text"][:500], "truncated": len(m["text"]) > 500} for m in selected[args.offset:args.offset + args.limit]], "nextOffset": args.offset + args.limit if len(selected) > args.offset + args.limit else None}
            m = next((m for m in materials if m["id"] == args.id), None)
            require(m, "MATERIAL_NOT_FOUND")
            if args.verify_source:
                require(m["ref"]["channel"] == "browser-visit", "VERIFY_SOURCE_REQUIRES_BROWSER_MATERIAL")
                job_browser.verify(m, c, command)
            end = min(len(m["text"]), args.offset + args.max_chars)
            require(args.offset <= len(m["text"]), "INVALID_READ_OFFSET")
            seen = meta.setdefault("read", {}).get(m["id"], 0)
            if args.offset <= seen:
                meta["read"][m["id"]] = max(seen, end)
            state.save_batch(path, meta)
            return {**{k: v for k, v in m.items() if k not in ("text", "browserVisits", "browserBundle")}, "text": m["text"][args.offset:end], "offset": args.offset, "nextOffset": end if end < len(m["text"]) else None}
        if args.command == "validate":
            require(args.facts, "FACTS_REQUIRED")
            result = job_facts.validate(path, meta, args.facts, state, suiji_module().work_records)
            state.save_batch(path, meta)
            return result
        if args.command == "publish":
            # The validated immutable export is the only publish input.
            return publish(state, path, meta)
        require(meta.get("pending"), "NO_PENDING_REQUEST")
        require(c["suiji"]["autoPublish"], "AUTO_PUBLISH_DISABLED")
        result = confirm(state, path, meta, suiji_module())
        return {"receipt": result, "next": "publish to finish remaining days"}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        # Never echo provider stderr, tokens or private input bodies.
        known = isinstance(error, Failure) or type(error).__module__ == "suiji"
        print(json.dumps({"ok": False, "error": str(error) if known else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
