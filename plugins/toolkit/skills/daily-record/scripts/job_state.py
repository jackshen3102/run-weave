"""Private local state for the shared scheduled Daily Record workflow."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import sys
import copy
import uuid
from zoneinfo import ZoneInfo


class Failure(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Failure(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file() and not path.stat().st_mode & 0o077, "PRIVATE_FILE_REQUIRED")
    return json.loads(path.read_bytes())


def write(path, value):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".daily-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def directory(path):
    path = Path(path)
    require(not path.is_symlink(), "DIRECTORY_SYMLINK_REJECTED")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.is_dir() and not path.stat().st_mode & 0o077, "PRIVATE_DIRECTORY_REQUIRED")
    return path


def date(value):
    parsed = dt.date.fromisoformat(value)
    require(parsed.isoformat() == value, "INVALID_DATE")
    return parsed


def today():
    return dt.datetime.now(ZoneInfo("Asia/Shanghai")).date()


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def window(day):
    start = dt.datetime.combine(date(day), dt.time(), ZoneInfo("Asia/Shanghai"))
    return {"from": start.isoformat(), "to": (start + dt.timedelta(days=1)).isoformat()}


def exact(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= set(value) and not set(value) - set(required) - set(optional), "INVALID_CONFIG_FIELDS")


def scope(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value), "INVALID_SCOPE")


def config(path):
    c = read(path)
    exact(c, {"schemaVersion", "producerId", "sourceNamespace", "startDate", "timeZone", "stateDir", "collectorArgv", "sources", "projectAliases", "suiji"}, {"maxDaysPerRun"})
    require(c["schemaVersion"] == 1 and c["timeZone"] == "Asia/Shanghai", "INVALID_JOB_VERSION_OR_TIMEZONE")
    scope(c["producerId"])
    scope(c["sourceNamespace"])
    date(c["startDate"])
    exact(c["sources"], {"localAgent", "feishu"}, {"browser", "screen"})
    local, feishu = c["sources"]["localAgent"], c["sources"]["feishu"]
    exact(local, {"providers"}, {"home"})
    require(isinstance(local["providers"], list) and all(p in ("codex", "pi", "claude", "trae") for p in local["providers"]) and len(set(local["providers"])) == len(local["providers"]), "INVALID_PROVIDERS")
    exact(feishu, {"enabled", "channels"}, {"accountScope"})
    require(type(feishu["enabled"]) is bool and feishu["channels"] == "messages", "MESSAGES_ONLY")
    if feishu["enabled"]:
        scope(feishu.get("accountScope"))
    browser = c["sources"].get("browser", {"enabled": False})
    require(type(browser.get("enabled")) is bool, "INVALID_BROWSER_ENABLED")
    if browser["enabled"]:
        exact(browser, {"enabled", "effectiveFrom", "root", "collectorArgv", "expectedSourceIds"})
        require(sys.platform == "darwin", "BROWSER_REQUIRES_MACOS")
        date(browser["effectiveFrom"])
        require(browser["effectiveFrom"] >= c["startDate"], "BROWSER_BEFORE_JOB_START")
        require(isinstance(browser["root"], str) and Path(browser["root"]).is_absolute(), "ABSOLUTE_PATH_REQUIRED")
        require(isinstance(browser["collectorArgv"], list) and browser["collectorArgv"] and all(isinstance(v, str) and v and "\0" not in v for v in browser["collectorArgv"]), "INVALID_BROWSER_ARGV")
        ids = browser["expectedSourceIds"]
        require(isinstance(ids, list) and ids and len(ids) == len(set(ids)) and all(isinstance(v, str) and str(uuid.UUID(v)) == v for v in ids), "INVALID_BROWSER_SOURCE_IDS")
    else:
        exact(browser, {"enabled"})
        # Keep the original binding byte-for-byte for old/disabled configurations.
        c["sources"].pop("browser", None)
    screen = c["sources"].get("screen", {"enabled": False})
    require(type(screen.get("enabled")) is bool, "INVALID_SCREEN_ENABLED")
    if screen["enabled"]:
        exact(screen, {"enabled", "effectiveFrom", "expectedDeviceID", "exporterArgv"})
        require(sys.platform == "darwin", "SCREEN_REQUIRES_MACOS")
        date(screen["effectiveFrom"])
        require(screen["effectiveFrom"] >= c["startDate"], "SCREEN_BEFORE_JOB_START")
        require(isinstance(screen["expectedDeviceID"], str) and str(uuid.UUID(screen["expectedDeviceID"])).lower() == screen["expectedDeviceID"].lower(), "INVALID_SCREEN_DEVICE")
        argv = screen["exporterArgv"]
        require(isinstance(argv, list) and argv and all(isinstance(v, str) and v and "\0" not in v for v in argv), "INVALID_SCREEN_ARGV")
        require(argv[1:] == ["screen-recording", "analysis", "export", "--instance", "stable"], "SCREEN_EXPORTER_MUST_USE_STABLE")
        require(Path(argv[0]).is_absolute(), "ABSOLUTE_PATH_REQUIRED")
    else:
        exact(screen, {"enabled"})
        c["sources"].pop("screen", None)
    require(local["providers"] or feishu["enabled"] or (browser["enabled"] and browser["effectiveFrom"] == c["startDate"]), "NO_ENABLED_SOURCE_FOR_START_DATE")
    require(isinstance(c["collectorArgv"], list) and c["collectorArgv"] and all(isinstance(v, str) and v and "\0" not in v for v in c["collectorArgv"]), "INVALID_COLLECTOR_ARGV")
    exact(c["suiji"], {"configPath", "tokenFile", "autoPublish"})
    require(type(c["suiji"]["autoPublish"]) is bool, "INVALID_AUTO_PUBLISH")
    for value in [c["stateDir"], c["suiji"]["configPath"], c["suiji"]["tokenFile"]] + ([local["home"]] if "home" in local else []):
        require(isinstance(value, str) and Path(value).is_absolute(), "ABSOLUTE_PATH_REQUIRED")
    require(isinstance(c["projectAliases"], dict) and all(isinstance(k, str) and isinstance(v, str) and 0 < len(v.strip()) <= 80 and not any(ch in v for ch in "\r\n\t") for k, v in c["projectAliases"].items()), "INVALID_PROJECT_ALIASES")
    c.setdefault("maxDaysPerRun", 7)
    require(type(c["maxDaysPerRun"]) is int and 1 <= c["maxDaysPerRun"] <= 366, "INVALID_DAY_BUDGET")
    scopes(c)
    return c


def browser_enabled(c, day=None):
    browser = c["sources"].get("browser", {})
    return bool(browser.get("enabled") and (day is None or day >= browser["effectiveFrom"]))


def screen_enabled(c, day=None):
    screen = c["sources"].get("screen", {})
    return bool(screen.get("enabled") and (day is None or day >= screen["effectiveFrom"]))


def binding(c):
    connection = read(c["suiji"]["configPath"])
    value = {k: c[k] for k in ("producerId", "sourceNamespace", "startDate", "sources")}
    value["target"] = {k: connection[k] for k in ("endpoint", "serverId", "ownerId")}
    return digest(value)


def scopes(c, day=None):
    values = ["agent:" + c["producerId"] + ":" + p for p in c["sources"]["localAgent"]["providers"]]
    if c["sources"]["feishu"]["enabled"]:
        values.append("feishu:" + c["sources"]["feishu"]["accountScope"] + ":messages")
    if browser_enabled(c, day):
        values.append("browser:" + c["producerId"] + ":observed")
    if screen_enabled(c, day):
        values.append("screen:" + c["producerId"] + ":" + c["sources"]["screen"]["expectedDeviceID"] + ":observed")
    for value in values:
        scope(value)
    return values


def process_identity(pid):
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=5, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        raise Failure("OWNER_CHECK_UNAVAILABLE") from None


class State:
    def __init__(self, c, migrating=False):
        self.c = c
        self.migrating = migrating
        self.root = directory(Path(c["stateDir"]).resolve())
        self.file = self.root / "state.json"
        self.lock = None

    def __enter__(self):
        lock_path = self.root / "lock"
        require(not lock_path.is_symlink(), "LOCK_SYMLINK_REJECTED")
        self.lock = os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), "r+")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise Failure("BUSY") from None
        try:
            expected = binding(self.c)
            journal = self.root / "source-migration.json"
            require(self.migrating or not journal.exists(), "SOURCE_MIGRATION_IN_PROGRESS: resume migrate-sources")
            self.data = read(self.file) if self.file.exists() else {"schemaVersion": 1, "binding": expected, "days": {}, "identities": {}, "batches": {}, "excludedThreads": []}
            self.original_digest = digest(self.data)
            if not (self.migrating and journal.exists()):
                require(self.data.get("binding") == expected, "JOB_IDENTITY_OR_SOURCES_CHANGED")
        except Exception:
            self.lock.close()
            raise
        return self

    def __exit__(self, kind, error, traceback):
        try:
            if hasattr(self, "data") and digest(self.data) != self.original_digest:
                write(self.file, self.data)
        finally:
            self.lock.close()

    def batch(self, args):
        path = Path(args.batch).absolute()
        require(not path.is_symlink() and path.resolve().parent == (self.root / "batches").resolve(), "INVALID_BATCH_PATH")
        meta = read(path / "batch.json")
        require(meta["id"] in self.data["batches"] and self.data["active"] == meta["id"], "BATCH_NOT_ACTIVE")
        require(meta["runId"] == args.run_id and meta["generation"] == args.generation, "BATCH_OWNER_CHANGED")
        if meta.get("identitySnapshot") is not None:
            self.data["identities"] = meta["identitySnapshot"]
        self.data["days"].update(meta.get("confirmations", {}))
        return path, meta

    def save_batch(self, path, meta):
        write(path / "batch.json", meta)
        self.data["batches"][meta["id"]] = {"phase": meta["phase"], "path": str(path), "days": meta["days"]}

    def missing(self):
        result = []
        day = date(self.c["startDate"])
        while day < today():
            if not self.data["days"].get(day.isoformat(), {}).get("complete", False):
                result.append(day.isoformat())
            day += dt.timedelta(days=1)
        return result


def migrate_sources(state, current_path, next_path, dry_run):
    """Journal one additive browser or screen source under the existing lock."""
    target = str(Path(current_path).resolve())
    next_c = config(next_path)
    journal_path = state.root / "source-migration.json"
    completed_path = state.root / "source-migration-completed.json"
    if not journal_path.exists() and state.c == next_c and completed_path.exists():
        completed = read(completed_path)
        require(completed["configPath"] == target and completed["newConfig"] == next_c and state.data["binding"] == completed["newState"]["binding"], "MIGRATION_TARGET_CHANGED")
        return {"dryRun": dry_run, "migrated": True, "alreadyApplied": True, "affectedDays": completed["affectedDays"]}

    if journal_path.exists():
        journal = read(journal_path)
        require(journal["configPath"] == target and journal["newConfig"] == next_c, "MIGRATION_TARGET_CHANGED")
        require(state.data["binding"] in (journal["oldBinding"], journal["newState"]["binding"]) and state.c in (journal["oldConfig"], journal["newConfig"]), "MIGRATION_IDENTITY_CHANGED")
    else:
        added = [name for name, enabled in (("browser", browser_enabled), ("screen", screen_enabled)) if enabled(next_c) and not enabled(state.c)]
        require(len(added) == 1, "ADDITIVE_SOURCE_MIGRATION_ONLY")
        source = added[0]
        old_base, new_base = copy.deepcopy(state.c), copy.deepcopy(next_c)
        new_base["sources"].pop(source)
        require(old_base == new_base, "MIGRATION_MAY_ONLY_ADD_ONE_SOURCE")
        require(not state.data.get("active") and all(b["phase"] == "confirmed" for b in state.data["batches"].values()), "ACTIVE_OR_PENDING_BATCH: recover it before migration")
        updated = copy.deepcopy(state.data)
        updated["binding"] = binding(next_c)
        effective = next_c["sources"][source]["effectiveFrom"]
        affected = [d for d in updated["days"] if d >= effective]
        for day in affected:
            updated["days"][day]["complete"] = False
        journal = {"source": source, "configPath": target, "oldConfig": state.c, "newConfig": next_c, "oldBinding": state.data["binding"], "newState": updated, "affectedDays": affected}
    source = journal.get("source", "browser")
    result = {"dryRun": dry_run, "effectiveFrom": next_c["sources"][source]["effectiveFrom"], "affectedDays": journal["affectedDays"], "oldBinding": journal["oldBinding"], "newBinding": journal["newState"]["binding"]}
    if dry_run:
        return result
    if not journal_path.exists():
        write(state.root / ("before-" + source + "-config.json"), journal["oldConfig"])
        write(state.root / ("before-" + source + "-state.json"), state.data)
        write(journal_path, journal)
    write(state.file, journal["newState"])
    write(target, next_c)
    state.data = journal["newState"]
    state.original_digest = digest(state.data)
    journal_path.rename(state.root / "source-migration-completed.json")
    return {**result, "migrated": True}
