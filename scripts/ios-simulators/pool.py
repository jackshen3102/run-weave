#!/usr/bin/env python3
"""Two explicit simulator slots; durable task ownership, never time-based takeover."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

BASE = Path.home() / ".runweave"
APPS = {"runweave": "com.runweave.app.native", "suiji": "com.runweave.suiji"}


class PoolError(RuntimeError):
    def __init__(self, code, detail, exit_code=4):
        super().__init__(detail)
        self.code, self.exit_code = code, exit_code


def fail(code, detail, exit_code=4):
    raise PoolError(code, detail, exit_code)


def now():
    return datetime.now(timezone.utc).isoformat()


def capture(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=30)
    if result.returncode:
        fail("command_failed", result.stderr.strip() or result.stdout.strip(), 1)
    return result.stdout.strip()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def project(cwd=None):
    root = Path(capture(["git", "rev-parse", "--show-toplevel"], cwd)).resolve()
    common = Path(capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], root)).resolve()
    return root, hashlib.sha256(os.fsencode(common)).hexdigest()


def registry(repository):
    return BASE / "ios-simulators" / repository / "pool.json"


def udid_path(udid):
    if not re.fullmatch(r"[A-Fa-f0-9-]{36}", udid):
        fail("invalid_argument", "Expected a simulator UDID", 2)
    return BASE / "native-device" / "locks" / udid.upper()


@contextmanager
def guard(name):
    path = BASE / "ios-simulators" / "guards" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    # Never unlink guard files: another process may already have this inode open.
    with path.open("a+") as stream:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            owner = owner_at(name) if re.fullmatch(r"[A-Fa-f0-9-]{36}", name) else None
            fail("device_busy", json.dumps(owner, ensure_ascii=False) if owner else
                 "Another device or registry operation is in progress", 3)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def devices():
    data = json.loads(capture(["xcrun", "simctl", "list", "devices", "--json"]))
    return {d["udid"]: {**d, "runtime": runtime}
            for runtime, items in data["devices"].items() for d in items}


def check_external_runner(udid):
    # Keep comm last: macOS truncates it when args follows, even for Xcode's standard path.
    for line in capture(["ps", "-ww", "-axo", "pid=,comm="]).splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or Path(fields[1]).name not in ("xcodebuild", "xctest"):
            continue
        result = subprocess.run(["ps", "-ww", "-p", fields[0], "-o", "args="],
                                text=True, capture_output=True, timeout=10)
        # The process may have exited since enumeration. Never match a shell's command text.
        if result.returncode == 0 and udid.lower() in result.stdout.lower():
            fail("device_busy", f"Existing native runner PID {fields[0]} targets {udid}; coordinate with its owner", 3)


def load_pool(repository):
    try:
        pool = read(registry(repository))
    except FileNotFoundError:
        fail("pool_unconfigured", "Adopt two existing devices before starting a task", 2)
    except (ValueError, OSError):
        fail("pool_unconfigured", "Unreadable pool registry; inspect it before adoption", 2)
    if (pool.get("schemaVersion") != 1 or pool.get("repositoryId") != repository
            or set(pool.get("slots", {})) != set(APPS)):
        fail("pool_unconfigured", "Unknown or invalid pool schema", 2)
    ids = [pool["slots"][app].get("udid") for app in APPS]
    if not all(isinstance(value, str) for value in ids) or len(set(ids)) != 2:
        fail("pool_unconfigured", "Pool must contain two different UDIDs", 2)
    for value in ids:
        udid_path(value)
    return pool


def owner_at(udid):
    path = udid_path(udid)
    if not path.exists():
        return None
    try:
        owner = read(path / "owner.json")
        if not isinstance(owner, dict):
            raise ValueError("invalid owner")
        return owner
    except (ValueError, OSError):
        return {"code": "owner_identity_unknown"}


def identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def unsettled(owner):
    for child in owner.get("children", []):
        if child.get("state") == "spawn_failed":
            continue
        if child.get("state") == "spawning" or not child.get("pid"):
            return True
        if group_alive(child["pid"]):
            return True
    return False


def save_owner(owner):
    current = owner_at(owner["udid"])
    if not current or current.get("lease") != owner["lease"]:
        fail("lease_mismatch", "The device no longer belongs to this task")
    write(udid_path(owner["udid"]) / "owner.json", owner)


def task(root, app=None, udid=None, allow_finished=False):
    root = Path(root).resolve()
    try:
        lease = read(root / "simulator-lease.json")
    except (OSError, ValueError):
        fail("lease_mismatch", "Start a simulator task before using this task directory", 2)
    worktree, repository = project(root)
    if (lease.get("schemaVersion") != 1 or lease.get("repositoryId") != repository
            or lease.get("worktree") != str(worktree) or lease.get("taskDir") != str(root)):
        fail("lease_mismatch", "Task directory does not match its worktree/project")
    if app and app not in (lease["app"], APPS[lease["app"]]):
        fail("lease_mismatch", "App does not match the task", 2)
    if udid and udid.upper() != lease["udid"]:
        fail("unmanaged_simulator", "UDID does not match the task's fixed slot", 2)
    if allow_finished and lease.get("finishedAt"):
        return lease
    pool = load_pool(repository)
    if pool["slots"][lease["app"]]["udid"] != lease["udid"]:
        fail("lease_mismatch", "Task's device is no longer the registered slot")
    owner = owner_at(lease["udid"])
    if not owner or owner.get("lease") != lease["lease"] or any(
            owner.get(key) != lease.get(key) for key in ("worktree", "repositoryId", "taskDir", "app")):
        fail("lease_mismatch", "Task does not own this device")
    if owner.get("finishedAt") and not allow_finished:
        fail("lease_mismatch", "Task has already finished")
    return owner


class Operation:
    def __init__(self, owner):
        self.owner = owner

    def run(self, args, *, env=None, cwd=None, capture_output=False, timeout=None):
        child = {"program": Path(args[0]).name, "state": "spawning", "startedAt": now()}
        self.owner.setdefault("children", []).append(child)
        save_owner(self.owner)
        # No arguments persisted here: UI text and credentials must not enter ownership records.
        try:
            process = subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True,
                                       stdout=subprocess.PIPE if capture_output else None,
                                       stderr=subprocess.STDOUT if capture_output else None, text=True)
        except OSError:
            child.update(state="spawn_failed", endedAt=now())
            save_owner(self.owner)
            raise
        child.update(state="running", pid=process.pid, startIdentity=identity(process.pid))
        save_owner(self.owner)
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Do not pretend the operation or its descendants have ended.
            fail("cleanup_incomplete", "Owned command timed out; inspect its recorded process group")
        child.update(state="exited", exit=process.returncode, endedAt=now())
        save_owner(self.owner)
        return subprocess.CompletedProcess(args, process.returncode, output, None)


@contextmanager
def operation(root, app=None, udid=None):
    initial = task(root, app, udid)
    with guard(initial["udid"]):
        owner = task(root, app, udid)
        if unsettled(owner):
            fail("cleanup_incomplete", "A prior operation still has live or unknown children")
        owner["operation"] = {"pid": os.getpid(), "startIdentity": identity(os.getpid()), "startedAt": now()}
        save_owner(owner)
        op = Operation(owner)
        try:
            yield op
        finally:
            owner["operation"]["endedAt"] = now()
            save_owner(owner)


def adopt(runweave, suiji):
    _, repository = project()
    selected = {"runweave": runweave.upper(), "suiji": suiji.upper()}
    if len(set(selected.values())) != 2:
        fail("invalid_argument", "Choose two different existing simulators", 2)
    available = devices()
    with guard(repository):
        path = registry(repository)
        previous = load_pool(repository) if path.exists() else None
        all_ids = set(selected.values()) | ({s["udid"] for s in previous["slots"].values()} if previous else set())
        from contextlib import ExitStack
        with ExitStack() as stack:
            for udid in sorted(all_ids):
                udid_path(udid)
                stack.enter_context(guard(udid))
                if owner_at(udid):
                    fail("device_busy", f"{udid} has an owner; adoption refused", 3)
            slots = {}
            for app, udid in selected.items():
                device = available.get(udid)
                if not device or not device.get("isAvailable"):
                    fail("pool_device_missing", f"Unavailable simulator: {udid}", 2)
                check_external_runner(udid)
                slots[app] = {"udid": udid, "runtime": device["runtime"]}
            if previous:
                write(path.with_suffix(".previous.json"), previous)
            pool = {"schemaVersion": 1, "repositoryId": repository, "slots": slots}
            write(path, pool)
            return pool


def start(app, root):
    worktree, repository = project()
    root = Path(root).resolve()
    if not root.is_relative_to(worktree) or root == worktree:
        fail("invalid_argument", "Task directory must be inside the current worktree", 2)
    anchor = root
    while not anchor.exists():
        anchor = anchor.parent
    if project(anchor)[0] != worktree:
        fail("lease_mismatch", "Task path belongs to another linked worktree", 2)
    with guard(repository):
        pool = load_pool(repository)
        udid = pool["slots"][app]["udid"]
        with guard(udid):
            device = devices().get(udid)
            if not device or not device.get("isAvailable"):
                fail("pool_device_missing", f"Unavailable registered simulator: {udid}", 2)
            current = owner_at(udid)
            if current:
                fail("device_busy", json.dumps(current, ensure_ascii=False), 3)
            check_external_runner(udid)
            if root.exists():
                fail("invalid_argument", "Use a new task directory; existing tasks are never overwritten", 2)
            owner = {"schemaVersion": 1, "kind": "simulator-pool", "lease": uuid.uuid4().hex,
                     "repositoryId": repository, "worktree": str(worktree), "app": app,
                     "udid": udid, "taskDir": str(root), "startedAt": now(), "children": [],
                     "automationPending": False}
            try:
                udid_path(udid).mkdir(parents=True)
            except FileExistsError:
                fail("device_busy", "Another device tool owns this UDID", 3)
            # A failure after mkdir deliberately leaves unknown ownership, never silently unlocks.
            write(udid_path(udid) / "owner.json", owner)
            root.mkdir(parents=True)
            write(root / "simulator-lease.json", owner)
            return owner


def finish(root, recovering=False):
    initial = task(root, allow_finished=True)
    with guard(initial["udid"]):
        current = owner_at(initial["udid"])
        if initial.get("finishedAt") and (not current or current.get("lease") != initial["lease"]):
            return {"code": "already_finished", "lease": initial["lease"]}
        owner = task(root, allow_finished=True)
        if unsettled(owner):
            fail("cleanup_incomplete", "A prior operation still has live or unknown children")
        op = Operation(owner)
        if owner.get("automationPending"):
            version = capture(["agent-device", "--version"])
            if version != "0.21.3":
                fail("cleanup_incomplete", "Cleanup requires agent-device 0.21.3")
            state = str(Path(root).resolve() / "state")
            result = op.run(["agent-device", "daemon", "stop", "--state-dir", state, "--clean"],
                            capture_output=True, timeout=60)
            write(Path(root) / "simulator-cleanup.json", {"at": now(), "exit": result.returncode, "output": result.stdout})
            if result.returncode:
                fail("cleanup_incomplete", f"Task daemon cleanup failed; see {root}/simulator-cleanup.json")
            report = Path(state) / "daemon-shutdown.json"
            if report.exists():
                data = read(report)
                if data.get("providerReleases", {}).get("pending") or data.get("claims", {}).get("orphaned"):
                    fail("cleanup_incomplete", "agent-device retained runner resources; inspect daemon-shutdown.json")
            owner["automationPending"] = False
            save_owner(owner)
        if unsettled(owner):
            fail("cleanup_incomplete", "Owned child process group has not exited")
        check_external_runner(owner["udid"])
        owner["finishedAt"] = now()
        owner["recovered"] = recovering
        save_owner(owner)
        write(Path(root) / "simulator-lease.json", owner)
        shutil.rmtree(udid_path(initial["udid"]))
    return {"code": "finished", "lease": initial["lease"], "udid": initial["udid"]}


def status():
    root, repository = project()
    pool = load_pool(repository)
    available = devices()
    slots = {}
    for app, slot in pool["slots"].items():
        owner = owner_at(slot["udid"])
        device = available.get(slot["udid"])
        active = owner and owner.get("operation", {})
        active = active and identity(active.get("pid")) == active.get("startIdentity") and not active.get("endedAt")
        state = "missing" if not device or not device.get("isAvailable") else (
            "blocked" if owner and (owner.get("schemaVersion") != 1 or (unsettled(owner) and not active))
            else "busy" if owner else "free")
        slots[app] = {**slot, "state": state, "deviceState": device and device["state"], "owner": owner}
    ids = {slot["udid"] for slot in slots.values()}
    return {"repositoryId": repository, "worktree": str(root), "slots": slots,
            "unmanagedDevices": [{"udid": d["udid"], "name": d["name"], "state": d["state"]}
                                 for d in available.values() if d["udid"] not in ids]}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status").add_argument("--json", action="store_true")
    adopt_parser = sub.add_parser("adopt")
    adopt_parser.add_argument("--runweave", required=True)
    adopt_parser.add_argument("--suiji", required=True)
    adopt_parser.add_argument("--json", action="store_true")
    start_parser = sub.add_parser("start")
    start_parser.add_argument("--app", choices=APPS, required=True)
    start_parser.add_argument("--task-dir", required=True)
    start_parser.add_argument("--json", action="store_true")
    finish_parser = sub.add_parser("finish")
    finish_parser.add_argument("--task-dir", required=True)
    finish_parser.add_argument("--json", action="store_true")
    recover = sub.add_parser("recover")
    recover.add_argument("--lease", required=True)
    recover.add_argument("--udid", required=True)
    recover.add_argument("--json", action="store_true")
    for command in ("build", "run", "doctor"):
        command_parser = sub.add_parser(command)
        command_parser.add_argument("--app", choices=APPS, required=True)
        command_parser.add_argument("--simulator")
        command_parser.add_argument("--task-dir")
        command_parser.add_argument("--configuration", choices=("Debug", "Profile", "Release"), default="Debug")
    execute = sub.add_parser("exec", help="Run a simulator XCTest command inside an existing task")
    execute.add_argument("--task-dir", required=True)
    execute.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.command == "status":
        result = status()
    elif options.command == "adopt":
        result = adopt(options.runweave, options.suiji)
    elif options.command == "start":
        result = start(options.app, options.task_dir)
    elif options.command == "finish":
        result = finish(options.task_dir)
    elif options.command == "recover":
        owner = owner_at(options.udid)
        if not owner or owner.get("lease") != options.lease or owner.get("kind") != "simulator-pool":
            fail("lease_mismatch", "Only the explicitly identified pool lease can be recovered")
        result = finish(owner["taskDir"], recovering=True)
    elif options.command == "exec":
        args = options.args[1:] if options.args[:1] == ["--"] else options.args
        with operation(options.task_dir) as op:
            # Fixed XCTest entry: callers cannot override the managed destination or parallelism.
            if not args or Path(args[0]).name != "xcodebuild" or any(
                    arg.startswith(("-destination", "-parallel-testing", "-maximum-concurrent-test", "-cloned")) for arg in args[1:]):
                fail("invalid_argument", "exec accepts xcodebuild with no destination/parallelism overrides", 2)
            args += ["-destination", f"platform=iOS Simulator,id={op.owner['udid']}",
                     "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1"]
            result = op.run(args, cwd=op.owner["worktree"])
            if result.returncode:
                fail("command_failed", f"xcodebuild exited {result.returncode}", 1)
            result = {"code": "executed", "udid": op.owner["udid"]}
    else:
        from build import run_app
        result = run_app(options)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    # build.py imports this module; keep one set of error and operation types.
    sys.modules["pool"] = sys.modules[__name__]
    try:
        main()
    except PoolError as error:
        print(json.dumps({"ok": False, "code": error.code, "detail": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(error.exit_code)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "code": "operation_failed", "detail": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
