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
    exact(c["sources"], {"localAgent", "feishu"})
    local, feishu = c["sources"]["localAgent"], c["sources"]["feishu"]
    exact(local, {"providers"}, {"home"})
    require(isinstance(local["providers"], list) and all(p in ("codex", "pi", "claude", "trae") for p in local["providers"]) and len(set(local["providers"])) == len(local["providers"]), "INVALID_PROVIDERS")
    exact(feishu, {"enabled", "channels"}, {"accountScope"})
    require(type(feishu["enabled"]) is bool and feishu["channels"] == "messages", "MESSAGES_ONLY")
    if feishu["enabled"]:
        scope(feishu.get("accountScope"))
    require(local["providers"] or feishu["enabled"], "NO_ENABLED_SOURCE")
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


def scopes(c):
    values = ["agent:" + c["producerId"] + ":" + p for p in c["sources"]["localAgent"]["providers"]]
    if c["sources"]["feishu"]["enabled"]:
        values.append("feishu:" + c["sources"]["feishu"]["accountScope"] + ":messages")
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
    def __init__(self, c):
        self.c = c
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
        connection = read(self.c["suiji"]["configPath"])
        binding = {k: self.c[k] for k in ("producerId", "sourceNamespace", "startDate", "sources")}
        binding["target"] = {k: connection[k] for k in ("endpoint", "serverId", "ownerId")}
        self.data = read(self.file) if self.file.exists() else {"schemaVersion": 1, "binding": digest(binding), "days": {}, "identities": {}, "batches": {}, "excludedThreads": []}
        require(self.data.get("binding") == digest(binding), "JOB_IDENTITY_OR_SOURCES_CHANGED")
        return self

    def __exit__(self, kind, error, traceback):
        try:
            if hasattr(self, "data"):
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
