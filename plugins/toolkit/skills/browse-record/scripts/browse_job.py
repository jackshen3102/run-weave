#!/usr/bin/env python3
"""Private, frozen browsing batches; never writes work facts or schedules tasks."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import uuid
from zoneinfo import ZoneInfo
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "suiji" / "scripts"))
import suiji


def require(ok, code):
    if not ok:
        raise suiji.Failure(code)


def read(path):
    return json.loads(suiji.private_read(path))


def write(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".browse-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def directory(path):
    p = Path(path)
    require(not p.is_symlink(), "SYMLINK_REJECTED")
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not p.stat().st_mode & 0o077, "PRIVATE_DIRECTORY_REQUIRED")
    return p


def config(path):
    c = read(path)
    require(set(c) - {"scheduledGroup"} == {"schemaVersion", "timeZone", "serverId", "ownerId", "connectionId", "externalAccountId", "machine", "profile", "group", "stateDir", "suijiConfig", "tokenFile"}, "INVALID_CONFIG_FIELDS")
    require(type(c.get("scheduledGroup", False)) is bool, "INVALID_SCHEDULED_GROUP_POLICY")
    require(c.get("schemaVersion") == 1 and c.get("timeZone") == "Asia/Shanghai", "INVALID_CONFIG")
    for key in ("serverId", "ownerId", "connectionId"):
        uuid.UUID(c[key])
    require(c.get("externalAccountId") and c.get("machine") == socket.gethostname(), "MACHINE_OR_ACCOUNT_BINDING_MISMATCH")
    for key in ("stateDir", "suijiConfig", "tokenFile"):
        require(Path(c[key]).is_absolute(), "ABSOLUTE_PRIVATE_PATH_REQUIRED")
    connection = read(c["suijiConfig"])
    require(connection.get("mcpPath") == "/mcp/browse" and all(connection.get(k) == c[k] for k in ("serverId", "ownerId")), "BROWSE_CREDENTIAL_IDENTITY_REQUIRED")
    require(c.get("profile") in ("profile-1", "profile-2", "profile-3") and c.get("group"), "BROWSER_BINDING_REQUIRED")
    return c


@contextlib.contextmanager
def lock(c):
    root = directory(c["stateDir"])
    locks = directory(Path.home() / ".runweave" / "browse-record" / "locks")
    path = locks / (c["serverId"] + "-" + c["ownerId"] + "-" + c["connectionId"] + ".lock")
    require(not path.is_symlink(), "SYMLINK_REJECTED")
    with os.fdopen(os.open(path, os.O_CREAT | os.O_RDWR, 0o600), "w") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise suiji.Failure("CONNECTION_BUSY") from None
        yield root


def command(argv, timeout=120):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0 or "### Error" in result.stdout:
        code = next((c for c in ("NEEDS_LOGIN", "ACCOUNT_CHANGED_DURING_RUN", "ACCOUNT_CHANGED", "IDENTITY_UNAVAILABLE", "HISTORY_UNAVAILABLE_OR_PARSE_FAILED") if c in result.stdout), "BROWSER_UNAVAILABLE_OR_READ_FAILED")
        raise suiji.Failure(code)
    return result.stdout


def browser_read(c, options, folder):
    group = c["group"]
    scheduled_run = os.environ.get("RUNWEAVE_SCHEDULED_TASK_RUN_ID")
    if scheduled_run:
        require(c.get("scheduledGroup") is True, "SCHEDULED_GROUP_NOT_AUTHORIZED")
        uuid.UUID(scheduled_run)
        group = "browser-group-scheduled-" + scheduled_run
    resolution = json.loads(command([os.environ.get("RUNWEAVE_CLI_BIN", "rw"), "browser", "profile", "resolve", "--profile", c["profile"].split("-")[-1], "--group-id", group, "--json"]))
    require(resolution.get("profileId") == c["profile"] and resolution.get("browserGroupId") == group, "BROWSER_BINDING_CHANGED")
    write(folder / "browser-binding.json", {"machine": c["machine"], "profile": c["profile"], "group": group, "scheduledRunId": scheduled_run})
    session = "browse-" + c["connectionId"]
    cli = ["pnpm", "exec", "playwright", "cli", "-s=" + session]
    # CDP credentials exist in process memory only; never saved in the config or batch.
    command(cli + ["attach", "--cdp=" + resolution["cdpEndpoint"]])
    try:
        source = Path(__file__).with_name("zhihu-read.js").read_text()
        script = folder / "reader.js"
        descriptor = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(source.replace("/*BROWSE_OPTIONS*/ {}", json.dumps(options)))
        try:
            output = command(cli + ["run-code", "--filename=" + str(script)], timeout=1800)
            require("### Result\n" in output, "BROWSER_RESULT_UNAVAILABLE")
            return json.JSONDecoder().raw_decode(output.split("### Result\n", 1)[1])[0]
        finally:
            script.unlink(missing_ok=True)
    finally:
        command(cli + ["detach"])


def client(c):
    value, info = suiji.connect(read(c["suijiConfig"]), c["tokenFile"])
    require(info.get("features", {}).get("browse"), "BROWSE_SERVICE_UNAVAILABLE")
    return value


def prepare(c, config_path, start, end):
    require(dt.date.fromisoformat(start).isoformat() == start and dt.date.fromisoformat(end).isoformat() == end and start <= end, "INVALID_DATE_RANGE")
    with lock(c) as root:
        active_root = directory(Path.home() / ".runweave" / "browse-record" / "active")
        active_file = active_root / (c["serverId"] + "-" + c["ownerId"] + "-" + c["connectionId"] + ".json")
        resume = None
        if active_file.exists():
            active = read(active_file)
            path = Path(active["path"])
            manifest = read(path / "manifest.json")
            if manifest["state"] in ("prepared", "pending"):
                require(path.parent == root.resolve(), "ORIGINAL_BATCH_BELONGS_TO_ANOTHER_STATE_DIRECTORY")
                require(manifest["from"] == start and manifest["to"] == end, "RESOLVE_ORIGINAL_BATCH_FIRST")
                return {"batch": str(path), "runId": manifest["runId"], "state": manifest["state"], "reused": True}
            if manifest["state"] == "collecting":
                require(path.parent == root.resolve() and manifest["from"] == start and manifest["to"] == end and manifest["configHash"] == digest(c), "RECOVER_ORIGINAL_RANGE_FIRST")
                if (path / "payload.json").exists():
                    payload = read(path / "payload.json")
                    require(payload["identityBefore"] == c["externalAccountId"] == payload["identityAfter"], "ACCOUNT_CHANGED")
                    manifest.update(state="prepared", payloadHash=digest(payload))
                    write(path / "manifest.json", manifest)
                    return {"batch": str(path), "runId": manifest["runId"], "state": "prepared", "reused": True}
                resume = (manifest["runId"], path)
        run = resume[0] if resume else str(uuid.uuid4())
        path = resume[1] if resume else directory(root / run)
        manifest = {"state": "collecting", "runId": run, "from": start, "to": end, "config": str(Path(config_path).resolve()), "configHash": digest(c), "leaseExpiresAt": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).isoformat()}
        write(path / "manifest.json", manifest)
        write(active_file, {"path": str(path), "runId": run})
        try:
            result = browser_read(c, {"from": start, "to": end, "externalAccountId": c["externalAccountId"], "connectionId": c["connectionId"]}, path)
            require(result.get("identityBefore") == c["externalAccountId"] == result.get("identityAfter"), "ACCOUNT_CHANGED")
            payload = {k: result[k] for k in ("identityBefore", "identityAfter", "items", "coverage")}
            payload.update(runId=run, connectionId=c["connectionId"], externalAccountId=c["externalAccountId"], **{"from": start, "to": end})
            write(path / "payload.json", payload)
            manifest.update(state="prepared", payloadHash=digest(payload), historyUnchanged=result["historyUnchanged"])
            write(path / "manifest.json", manifest)
            return {"batch": str(path), "runId": run, "coverage": result["coverage"], "historyUnchanged": result["historyUnchanged"]}
        except Exception as error:
            code = str(error)
            reason = "needs-login" if code == "NEEDS_LOGIN" else "identity-changed" if "ACCOUNT_CHANGED" in code else "parse-failed" if "PARSE" in code else "unavailable"
            manifest["error"] = reason
            try:
                client(c).call("report_browse_failure", {"idempotencyKey": run, "input": {"runId": run, "connectionId": c["connectionId"], "externalAccountId": c["externalAccountId"], "from": start, "to": end, "reason": reason}})
            except Exception:
                manifest["failureReceiptUnconfirmed"] = True
            manifest["state"] = "failed"
            write(path / "manifest.json", manifest)
            raise


def batch(path):
    path = Path(path).resolve()
    meta = read(path / "manifest.json")
    c = config(meta["config"])
    require(digest(c) == meta["configHash"] and path.parent == Path(c["stateDir"]).resolve(), "BATCH_IDENTITY_CHANGED")
    return path, meta, c


def import_batch(path, reconcile=False):
    path, meta, c = batch(path)
    with lock(c) as root:
        if reconcile and meta["state"] == "failed":
            cli = client(c)
            try:
                receipt = cli.call("get_browse_run", {"runId": meta["runId"]})
            except suiji.Failure as error:
                require(str(error) == "NOT_FOUND", "RECEIPT_READ_UNAVAILABLE")
                receipt = cli.call("report_browse_failure", {"idempotencyKey": meta["runId"], "input": {"runId": meta["runId"], "connectionId": c["connectionId"], "externalAccountId": c["externalAccountId"], "from": meta["from"], "to": meta["to"], "reason": meta["error"]}})
            require(meta["error"] in receipt["coverage"]["errors"], "FAILURE_RECEIPT_MISMATCH")
            write(path / "receipt.json", receipt)
            meta["failureReceiptUnconfirmed"] = False
            write(path / "manifest.json", meta)
            return {"runId": meta["runId"], "failed": True, "reported": True}
        payload = read(path / "payload.json")
        require(digest(payload) == meta["payloadHash"], "FROZEN_PAYLOAD_CHANGED")
        require(meta["state"] in ("prepared", "pending", "confirmed"), "BATCH_NOT_PREPARED")
        cli = client(c)
        if reconcile or meta["state"] in ("pending", "confirmed"):
            try:
                receipt = cli.call("get_browse_run", {"runId": meta["runId"]})
            except suiji.Failure as error:
                require(str(error) == "NOT_FOUND", "RECEIPT_READ_UNAVAILABLE")
                receipt = None
            if receipt:
                require(receipt["connectionId"] == c["connectionId"] and receipt["from"] == meta["from"] and receipt["to"] == meta["to"], "RECEIPT_IDENTITY_MISMATCH")
                write(path / "receipt.json", receipt)
                meta["state"] = "confirmed"; write(path / "manifest.json", meta)
                write(root / (c["connectionId"] + ".checkpoint.json"), {"runId": meta["runId"], "from": meta["from"], "to": meta["to"], "coverage": receipt["coverage"]})
                return {"runId": meta["runId"], "confirmed": True, "receipt": receipt["receipt"]}
        meta["state"] = "pending"; write(path / "manifest.json", meta)
        cli.call("import_browse_entries", {"idempotencyKey": meta["runId"], "input": payload})
        # Independent readback confirms commit even when the original response was lost.
        receipt = cli.call("get_browse_run", {"runId": meta["runId"]})
        require(receipt["connectionId"] == c["connectionId"], "RECEIPT_IDENTITY_MISMATCH")
        write(path / "receipt.json", receipt)
        meta["state"] = "confirmed"; write(path / "manifest.json", meta)
        write(root / (c["connectionId"] + ".checkpoint.json"), {"runId": meta["runId"], "from": meta["from"], "to": meta["to"], "coverage": receipt["coverage"]})
        return {"runId": meta["runId"], "confirmed": True, "receipt": receipt["receipt"]}


def read_digest(c, config_path, day):
    dt.date.fromisoformat(day)
    with lock(c) as root:
        cli = client(c)
        entries, cursor, revision = [], None, None
        while True:
            args = {"source": "zhihu", "from": day, "to": day, "limit": 100}
            if cursor:
                args["cursor"] = cursor
            page = cli.call("list_browse_entries", args)
            require(revision in (None, page["browseRevision"]), "BROWSE_CHANGED: restart digest read")
            revision = page["browseRevision"]
            for entry in page["items"]:
                if entry["source"]["connectionId"] == c["connectionId"]:
                    value = cli.call("get_browse_entry", {"id": entry["id"]})["entry"]
                    require(value["version"] == entry["version"] and not value["deletedAt"], "BROWSE_CHANGED")
                    entries.append(value)
            cursor = page["nextCursor"]
            if not cursor:
                break
        path = directory(root / str(uuid.uuid4()))
        refs = [{"id": e["id"], "version": e["version"], "hash": e["contentHash"]} for e in entries]
        value = {"date": day, "connectionId": c["connectionId"], "entries": entries, "entryRefs": refs, "inputRevision": revision}
        write(path / "input.json", value)
        write(path / "manifest.json", {"state": "digest-input", "config": str(Path(config_path).resolve()), "configHash": digest(c), "inputHash": digest(value), "key": str(uuid.uuid4())})
        return {"batch": str(path), "input": str(path / "input.json"), "count": len(entries)}


def publish_digest(path, input_path):
    path, meta, c = batch(path)
    with lock(c):
        frozen = read(path / "input.json")
        require(digest(frozen) == meta["inputHash"], "DIGEST_INPUT_CHANGED")
        value = read(input_path)
        require(set(value) == {"title", "body", "entryRefs", "inputRevision"} and value["entryRefs"] == frozen["entryRefs"] and value["inputRevision"] == frozen["inputRevision"], "DIGEST_REFERENCES_CHANGED")
        payload = {**value, "date": frozen["date"], "connectionId": c["connectionId"]}
        if meta.get("payloadHash"):
            require(meta["payloadHash"] == digest(payload), "FROZEN_DIGEST_CHANGED")
        meta.update(state="pending-digest", payloadHash=digest(payload)); write(path / "manifest.json", meta)
        cli = client(c)
        result = cli.call("publish_browse_digest", {"idempotencyKey": meta["key"], "input": payload})
        confirmed = cli.call("list_browse_digests", {"date": frozen["date"], "connectionId": c["connectionId"]})
        require(any(item["id"] == result["digest"]["id"] and item["version"] == result["digest"]["version"] for item in confirmed["items"]), "DIGEST_READBACK_MISMATCH")
        meta["state"] = "confirmed-digest"; write(path / "manifest.json", meta)
        write(path / "receipt.json", result)
        return {"confirmed": True, "id": result["digest"]["id"], "version": result["digest"]["version"]}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "import", "reconcile", "read", "publish-digest"])
    for name in ("config", "from", "to", "batch", "date", "input"):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    if args.command in ("import", "reconcile"):
        return import_batch(args.batch, args.command == "reconcile")
    if args.command == "publish-digest":
        return publish_digest(args.batch, args.input)
    c = config(args.config)
    if args.command == "read":
        return read_digest(c, args.config, args.date)
    now = dt.datetime.now(ZoneInfo("Asia/Shanghai")).date()
    return prepare(c, args.config, getattr(args, "from") or (now - dt.timedelta(days=1)).isoformat(), args.to or now.isoformat())


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, suiji.Failure) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
