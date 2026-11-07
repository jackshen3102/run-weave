"""Retire legacy browsing inputs without replaying unknown work writes."""
import copy
from pathlib import Path
from job_state import require, read, write, binding, process_identity, digest


def blocked_scope(value):
    return any(value.startswith(p) for p in ("browser:", "materials:", "browse:"))


def assert_payload(payload):
    require(not payload.get("materialResults") and not any(
        any(blocked_scope(s) for s in day.get("requestedScopes", [])) or
        any(ref.get("channel") in ("browser-visit", "suiji-material") or blocked_scope(ref.get("sourceScope", ""))
            for fact in day.get("facts", []) for ref in fact.get("sourceRefs", []))
        for day in payload.get("days", [])), "BROWSING_IS_NOT_WORK: retire the old batch with isolate-work")


def migrate(state, config_path, dry_run, suiji):
    require(not (state.root / "source-migration.json").exists(), "FINISH_SOURCE_MIGRATION_FIRST")
    journal = state.root / "work-isolation.json"
    if journal.exists():
        saved = read(journal)
        require(saved["configPath"] == str(Path(config_path).resolve()), "ISOLATION_TARGET_CHANGED")
        original_state = read(state.root / "before-work-isolation-state.json")
        original_config = read(state.root / "before-work-isolation-config.json")
        require(state.data.get("binding") in (saved["state"]["binding"], original_state["binding"]) and state.c in (saved["config"], original_config), "ISOLATION_IDENTITY_CHANGED")
        if not dry_run:
            write(state.file, saved["state"])
            write(config_path, saved["config"])
            state.data = saved["state"]
        return {"dryRun": dry_run, "isolated": not dry_run, "newContextRequired": True}
    updated = copy.deepcopy(state.data)
    config = copy.deepcopy(state.c)
    for key in ("browser", "materials"):
        config["sources"].pop(key, None)
    active = updated.get("active")
    receipt = None
    if active:
        path = Path(updated["batches"][active]["path"])
        meta = read(path / "batch.json")
        require(process_identity(meta["ownerPid"]) != meta["ownerProcess"], "BUSY: original Agent is still active")
        pending = meta.get("pending")
        if pending:
            original = read(pending["request"])
            require(digest(original) == pending["hash"], "FROZEN_REQUEST_CHANGED")
            connection = read(config["suiji"]["configPath"])
            client, _ = suiji.connect(connection, config["suiji"]["tokenFile"])
            # This endpoint compares the original immutable operation hash and returns no fact bodies.
            receipt = client.call("get_work_import_receipt", {"idempotencyKey": original["arguments"]["idempotencyKey"], "input": original["arguments"]["input"]})
        updated["batches"][active] = {**updated["batches"][active], "phase": "retired-browsing", "receipt": receipt}
        updated["active"] = None
    updated["identities"] = {key: value for key, value in updated["identities"].items()
                             if not any(blocked_scope(a) for a in value.get("anchors", []))}
    updated["forbiddenWorkThreads"] = updated.get("excludedThreads", [])
    updated["workIsolationVersion"] = 1
    updated["binding"] = binding(config)
    for day in updated["days"].values():
        day["receipts"] = [r for r in day.get("receipts", []) if not blocked_scope(r["sourceScope"])]
        day["complete"] = bool(day["receipts"]) and all(r["status"] == "complete" for r in day["receipts"])
    result = {"dryRun": dry_run, "retiredBatch": active, "retainedIdentities": len(updated["identities"]), "receipt": receipt, "newContextRequired": True}
    if not dry_run:
        write(state.root / "before-work-isolation-state.json", state.data)
        write(state.root / "before-work-isolation-config.json", state.c)
        write(journal, {"configPath": str(Path(config_path).resolve()), "state": updated, "config": config})
        write(state.file, updated)
        write(config_path, config)
        state.data = updated
    return result
