#!/usr/bin/env python3
"""Shared signing identity, physical-device ownership and bounded QA artifacts."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time

BASE = Path.home() / ".runweave" / "agent-device"
RUNNER_ID = "com.runweave.agentdevice"
KEEP_TASKS = 20
MAX_AGE = 14 * 86400
MAX_BYTES = 1024 ** 3


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


@contextmanager
def guard():
    BASE.mkdir(parents=True, exist_ok=True)
    with (BASE / "resources.lock").open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("device_busy: another managed operation is active")
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def shared_runner(team, requested=None):
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise RuntimeError("Expected a ten-character signing Team ID")
    if requested and requested != RUNNER_ID:
        raise RuntimeError(f"Runner identity is shared: use {RUNNER_ID}; task-specific IDs are forbidden")
    path = BASE / "runners" / f"{team}.json"
    if not path.exists():
        write(path, {"teamId": team, "runnerId": RUNNER_ID})
    if read(path) != {"teamId": team, "runnerId": RUNNER_ID}:
        raise RuntimeError("Shared runner registry differs; inspect before changing signing identity")
    return RUNNER_ID


def register(root):
    paths = read(BASE / "tasks.json") if (BASE / "tasks.json").exists() else []
    if str(root) not in paths:
        write(BASE / "tasks.json", [*paths, str(root)])


def device_lock(config):
    udid = config["udid"]
    if not re.fullmatch(r"[A-Fa-f0-9-]+", udid):
        raise RuntimeError("Invalid hardware UDID")
    return Path.home() / ".runweave/native-device/locks" / udid.upper()


@contextmanager
def physical_operation(root, config):
    with guard():
        path = device_lock(config)
        if path.exists():
            owner = read(path / "owner.json")
            if owner.get("kind") != "agent-device" or owner.get("taskDir") != str(root):
                raise RuntimeError(f"device_busy: {path / 'owner.json'}")
        else:
            active_local()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.mkdir()  # Atomic with the existing native XCTest entry's lock.
            write(path / "owner.json", {"kind": "agent-device", "taskDir": str(root),
                  "udid": config["udid"], "session": config["session"], "startedAt": time.time()})
        register(root)
        yield


def finished(root, config):
    path = device_lock(config)
    owner = read(path / "owner.json")
    if owner.get("kind") != "agent-device" or owner.get("taskDir") != str(root):
        raise RuntimeError("Device owner changed; refusing release")
    shutil.rmtree(path)
    write(root / "finished.json", {"finishedAt": time.time()})


def active_local():
    output = subprocess.check_output(["ps", "-ww", "-axo", "pid=,comm=,args="], text=True)
    for line in output.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3 or int(fields[0]) == os.getpid():
            continue
        name = Path(fields[1]).name
        if name in ("xcodebuild", "xctest") or (name == "node" and "agent-device" in fields[2]):
            raise RuntimeError(f"Resources busy: PID {fields[0]} ({name}); stop its owner before pruning")


def size(path):
    return int(subprocess.check_output(["du", "-sk", str(path)], text=True).split()[0]) * 1024


def task_paths(workspace=None):
    paths = set(read(BASE / "tasks.json") if (BASE / "tasks.json").exists() else [])
    if workspace:
        output = subprocess.check_output(["git", "-C", str(workspace), "worktree", "list", "--porcelain"], text=True)
        for line in output.splitlines():
            if line.startswith("worktree "):
                base = Path(line[9:]) / ".runweave/mobile-qa"
                paths.update(str(p.parent) for p in base.glob("*/session.json"))
    return [Path(p) for p in sorted(paths)]


def legacy_builds(workspace, protected, all_history):
    if not workspace:
        return []
    output = subprocess.check_output(["git", "-C", str(workspace), "worktree", "list", "--porcelain"], text=True)
    builds = []
    for line in output.splitlines():
        if not line.startswith("worktree "):
            continue
        base = Path(line[9:]) / ".runweave"
        for root, directories, files in os.walk(base, followlinks=False):
            path = Path(root)
            if any(path == Path(p) or Path(p) in path.parents for p in protected):
                directories[:] = []
                continue
            if "info.plist" in files and (path / "Build").is_dir():
                try:
                    data = plistlib.loads((path / "info.plist").read_bytes())
                except (OSError, ValueError, plistlib.InvalidFileException):
                    data = {}
                source = str(data.get("WorkspacePath", ""))
                if source.endswith(".xcodeproj") and source.startswith(str(base.parent) + "/"):
                    builds.append({"path": str(path), "bytes": size(path), "workspace": source,
                                   "remove": all_history})
                    directories[:] = []
                    continue
            if path.name in ("Build", "node_modules", "state", "browser-profile", "user-data"):
                directories[:] = []
    return builds


def inventory(workspace=None, all_history=False):
    protected = set()
    for p in (Path.home() / ".runweave/native-device/locks").glob("*/owner.json"):
        owner = read(p)
        if owner.get("taskDir"):
            protected.add(owner["taskDir"])
    tasks = []
    for path in task_paths(workspace):
        if not path.exists() or path.is_symlink() or not (path / "session.json").is_file():
            continue
        config = read(path / "session.json")
        if config.get("app") not in ("com.runweave.app.native", "com.runweave.suiji"):
            continue
        if path.name in ("", "state") or str(path) in protected:
            continue
        tasks.append({"path": str(path), "bytes": size(path), "modifiedAt": path.stat().st_mtime})
    tasks.sort(key=lambda x: x["modifiedAt"], reverse=True)
    total = 0
    for index, task in enumerate(tasks):
        total += task["bytes"]
        task["remove"] = (all_history or index >= KEEP_TASKS or total > MAX_BYTES
                          or time.time() - task["modifiedAt"] > MAX_AGE)
    protected_sessions = {read(Path(p) / "session.json").get("session") for p in protected
                          if (Path(p) / "session.json").is_file()}
    logs = []
    for path in (Path.home() / ".agent-device/logs").glob("qa-*"):
        if path.is_symlink() or not path.is_dir() or path.name in protected_sessions:
            continue
        if not re.fullmatch(r"qa-[a-f0-9]{12}", path.name):
            continue
        logs.append({"path": str(path), "bytes": size(path), "modifiedAt": path.stat().st_mtime})
    total = 0
    for index, log in enumerate(sorted(logs, key=lambda x: x["modifiedAt"], reverse=True)):
        total += log["bytes"]
        log["remove"] = (all_history or index >= KEEP_TASKS or total > MAX_BYTES
                         or time.time() - log["modifiedAt"] > MAX_AGE)
    caches = []
    base = Path.home() / ".agent-device/apple-runner/derived"
    for path in base.glob("*/*"):
        manifest = path / ".agent-device-runner-cache.json"
        if path.is_symlink() or not manifest.is_file():
            continue
        data = read(manifest)
        bundle = next((v.split("=", 1)[1] for v in data.get("runnerBundleBuildSettings", [])
                       if v.startswith("AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=")), "")
        if not bundle.startswith("com.runweave."):
            continue
        caches.append({"path": str(path), "bytes": size(path), "bundleId": bundle,
                       "group": [data.get("deviceKind"), data.get("runnerSigningBuildSettings")],
                       "modifiedAt": manifest.stat().st_mtime, "remove": bundle != RUNNER_ID})
    kept = []
    for cache in sorted(caches, key=lambda x: x["modifiedAt"], reverse=True):
        if not cache["remove"]:
            if cache["group"] in kept:
                cache["remove"] = True
            else:
                kept.append(cache["group"])
    return {"tasks": tasks, "caches": caches, "logs": logs,
            "legacyBuilds": legacy_builds(workspace, protected, all_history), "protectedTasks": sorted(protected),
            "limits": {"tasks": KEEP_TASKS, "days": MAX_AGE // 86400, "bytes": MAX_BYTES}}


def prune(workspace=None, apply=False, all_history=False):
    with guard():
        active_local()
        report = inventory(workspace, all_history)
        if apply:
            # Keep a small audit, not a second copy of the deleted build products.
            write(BASE / "last-cleanup.json", report)
            for item in [*report["tasks"], *report["caches"], *report["logs"], *report["legacyBuilds"]]:
                if item["remove"] and Path(item["path"]).exists():
                    shutil.rmtree(item["path"])
            write(BASE / "tasks.json", [t["path"] for t in report["tasks"] if not t["remove"]] + report["protectedTasks"])
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "prune"))
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--all-history", action="store_true")
    args = parser.parse_args()
    report = prune(args.workspace, args.apply, args.all_history) if args.action == "prune" else inventory(args.workspace)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
