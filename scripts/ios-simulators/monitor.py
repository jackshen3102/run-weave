"""Read-only pool projection and ownership-checked release; no adoption or startup."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import pool

MAX_BYTES = 1024 * 1024


def safe_read(path):
    path = Path(path).absolute()
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise ValueError("Resource path contains a symbolic link")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        stat = os.fstat(descriptor)
        if stat.st_size > MAX_BYTES:
            raise ValueError("Resource record exceeds size limit")
        with os.fdopen(descriptor, "r", closefd=False) as stream:
            result = json.load(stream)
        named = path.stat(follow_symlinks=False)
        if (named.st_ino, named.st_dev) != (stat.st_ino, stat.st_dev):
            raise ValueError("Resource changed while reading")
        return result
    finally:
        os.close(descriptor)


def owner_version(owner):
    return hashlib.sha256(json.dumps([owner.get(key) for key in
        ("schemaVersion", "repositoryId", "worktree", "taskDir", "udid", "lease", "app", "slot", "startedAt")],
        ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def unknown_group(reason):
    return {"sourceState": "unavailable", "reason": reason, "resources": [],
            "counts": dict.fromkeys(("total", "busy", "free", "blocked", "unknown"))}


def valid_owner(owner, repository, slot, udid):
    if not isinstance(owner, dict) or owner.get("schemaVersion") != 1 or owner.get("kind") != "simulator-pool":
        return False
    return (owner.get("repositoryId") == repository and owner.get("udid", "").upper() == udid
            and owner.get("slot", owner.get("app")) == slot and owner.get("app") in pool.APPS
            and all(isinstance(owner.get(key), str) and owner[key] for key in ("lease", "taskDir", "worktree")))


def projection():
    registry_root = pool.BASE / "ios-simulators"
    if not registry_root.exists():
        return {"sourceState": "ready", "reason": "尚未配置受管理的模拟器", "resources": [],
                "counts": {"total": 0, "busy": 0, "free": 0, "blocked": 0, "unknown": 0}}
    if registry_root.is_symlink():
        return unknown_group("模拟器 registry 不允许符号链接")
    registrations = {}
    failures = []
    entries = list(registry_root.iterdir())
    if len(entries) > 256:
        failures.append("模拟器 registry 超过扫描上限")
    for entry in entries[:256]:
        if not re.fullmatch(r"[a-f0-9]{64}", entry.name):
            continue
        try:
            record = safe_read(entry / "pool.json")
            if (record.get("schemaVersion") != 1 or record.get("repositoryId") != entry.name
                    or set(record.get("slots", {})) != set(pool.APPS)):
                raise ValueError("Unknown registry schema")
            for slot, value in record["slots"].items():
                udid = value.get("udid", "").upper()
                pool.udid_path(udid)
                registrations.setdefault(udid, []).append((entry.name, slot, value))
        except (OSError, ValueError, pool.PoolError):
            failures.append("部分模拟器登记损坏或不可读取")
    if not registrations and failures:
        return unknown_group("；".join(sorted(set(failures))))
    if not registrations:
        return {"sourceState": "ready", "reason": "尚未配置受管理的模拟器", "resources": [],
                "counts": {"total": 0, "busy": 0, "free": 0, "blocked": 0, "unknown": 0}}
    available = pool.devices()
    try:
        tool = subprocess.run(["agent-device", "--version"], text=True, capture_output=True, timeout=5)
        tool_ready = tool.returncode == 0 and tool.stdout.strip() == "0.21.3"
    except (OSError, subprocess.TimeoutExpired):
        tool_ready = False
    resources = []
    for udid, records in sorted(registrations.items()):
        repository, slot, value = records[0]
        device = available.get(udid)
        resource = {"id": "simulator:" + udid, "kind": "simulator", "label": device.get("name") if device else value.get("name", udid),
                    "state": "unknown", "owner": None, "ownershipVersion": None,
                    "details": {"path": None, "udid": udid, "deviceState": device and device.get("state"), "ports": [], "processes": []},
                    "release": {"action": None, "disabledReason": None}, "operation": None, "reason": None}
        lock = pool.udid_path(udid)
        try:
            owner = safe_read(lock / "owner.json") if lock.exists() else None
            if len(records) != 1:
                raise ValueError("同一物理 UDID 存在冲突登记")
            if not device or not device.get("isAvailable"):
                raise ValueError("模拟器不可用，请检查 Xcode 设备状态")
            if owner is None:
                # A foreign XCTest runner is occupancy even without our owner lock.
                pool.check_external_runner(udid)
                resource["state"] = "free"
            else:
                if not valid_owner(owner, repository, slot, udid):
                    raise ValueError("占用身份与模拟器登记不一致")
                version = owner_version(owner)
                resource["ownershipVersion"] = version
                resource["owner"] = {"id": owner["lease"], "task": Path(owner["taskDir"]).name,
                    "worktree": Path(owner["worktree"]).name, "startedAt": owner.get("startedAt"),
                    "lastActivityAt": owner.get("lastActivityAt")}
                resource["details"]["path"] = owner["taskDir"]
                runner_path = Path.home() / ".agent-device/apple-runner/leases" / (udid + ".json")
                if runner_path.exists():
                    runner = safe_read(runner_path)
                    pid = runner.get("runnerPid")
                    if isinstance(pid, int) and pid > 1 and pool.identity(pid):
                        owned = runner.get("ownerStateDir") == str(Path(owner["taskDir"]) / "state") and runner.get("runnerStartTime") == pool.identity(pid)
                        resource["details"]["processes"].append({"name": "XCTest Runner", "pid": pid, "ownership": "owned" if owned else "unknown", "cpuPercent": None, "rssBytes": None})
                        if not owned:
                            raise ValueError("Runner 身份与任务不一致")
                active = bool(pool.active_operation(owner))
                unresolved = pool.unsettled(owner)
                residual = bool(owner.get("finishedAt") or (pool.idle_seconds(owner) or 0) >= pool.IDLE_SECONDS)
                resource["state"] = "blocked" if unresolved and not active or residual else "busy"
                reason = "自有子进程尚未确认退出" if unresolved else "任务残留占用，需要确认清理" if residual else None
                for child in owner.get("children", []):
                    pid = child.get("pid")
                    if isinstance(pid, int) and pool.group_alive(pid):
                        resource["details"]["processes"].append({"name": child.get("program", "Runner"), "pid": pid,
                            "ownership": "owned" if child.get("startIdentity") and pool.identity(pid) == child["startIdentity"] else "unknown",
                            "cpuPercent": None, "rssBytes": None})
                allowed = not active and not unresolved and tool_ready
                try:
                    lease = safe_read(Path(owner["taskDir"]) / "simulator-lease.json")
                    if owner_version(lease) != version:
                        raise ValueError("任务资料与当前占用不一致")
                    pool.task(owner["taskDir"], allow_finished=True)
                except (OSError, ValueError, pool.PoolError):
                    allowed = False
                    reason = "任务目录或 lease 无法核实，请检查占用资料"
                if owner_version(safe_read(lock / "owner.json")) != version:
                    raise ValueError("读取期间占用者变化")
                resource["reason"] = reason
                resource["release"] = {"action": ("release-occupancy" if residual else "stop-and-release") if allowed else None,
                    "disabledReason": None if allowed else reason or ("自动化操作仍在运行，请稍后手动刷新" if active else "清理需要 agent-device 0.21.3")}
        except (OSError, ValueError, pool.PoolError) as error:
            resource["state"] = "unknown"
            resource["reason"] = str(error)
            resource["owner"] = None
            resource["ownershipVersion"] = None
            resource["details"]["path"] = None
            resource["details"]["processes"] = []
            resource["release"] = {"action": None, "disabledReason": resource["reason"]}
        resources.append(resource)
    counts = {"total": len(resources), "busy": 0, "free": 0, "blocked": 0, "unknown": 0}
    for resource in resources:
        counts[resource["state"]] += 1
    return {"sourceState": "partial" if failures or counts["unknown"] else "ready", "reason": "；".join(sorted(set(failures))) or None,
            "resources": resources, "counts": counts}


def release(request):
    resource = next((item for item in projection()["resources"] if item["id"] == request["resourceId"]), None)
    if not resource:
        pool.fail("resource_missing", "资源不存在")
    # The Node side validates its Backend generation; Python validates the lease under its UDID guard.
    expected = resource["ownershipVersion"]
    bound = hashlib.sha256(json.dumps([request["generation"], expected], separators=(",", ":")).encode()).hexdigest()
    if bound != request["expectedOwnershipVersion"]:
        pool.fail("owner_changed", "占用者已变化，请刷新后重新确认")
    if resource["ownershipVersion"] != expected or resource["release"]["action"] != request["action"]:
        pool.fail("owner_changed", "占用或清理条件已变化，请刷新后重新确认")
    root = resource["details"]["path"]

    def verify(owner):
        current = safe_read(pool.udid_path(owner["udid"]) / "owner.json")
        if owner_version(current) != expected or owner_version(owner) != expected:
            pool.fail("owner_changed", "占用者已变化，未执行释放")
        if pool.active_operation(current) or pool.unsettled(current):
            pool.fail("cleanup_incomplete", "自动化操作或子进程仍在运行")
        if owner_version(safe_read(Path(root) / "simulator-lease.json")) != expected:
            pool.fail("owner_changed", "任务 lease 已变化")

    pool.finish(root, recovering=request["action"] == "release-occupancy", verify_owner=verify)
    if pool.udid_path(resource["details"]["udid"]).exists():
        pool.fail("cleanup_incomplete", "owner lock 仍存在，释放尚未确认")
    return {"state": "released", "message": "模拟器任务已停止并释放"}


if __name__ == "__main__":
    try:
        result = release(json.load(sys.stdin)) if sys.argv[1:] == ["release"] else projection()
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"state": "blocked", "message": str(error),
                          "status": 409 if isinstance(error, pool.PoolError) and error.code == "owner_changed" else 200}, ensure_ascii=False))
        sys.exit(1)
