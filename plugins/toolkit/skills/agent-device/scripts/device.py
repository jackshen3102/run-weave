#!/usr/bin/env python3
"""Isolated iOS agent-device sessions; command status is not business acceptance."""

import argparse
import concurrent.futures
import json
import importlib.util
from contextlib import nullcontext
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


VERSION = "0.21.3"
sys.dont_write_bytecode = True


def capture(args, timeout=15):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or args[0])
    return result.stdout.strip()


def verify_version():
    actual = capture(["agent-device", "--version"])
    if not re.search(rf"(?<![\d.]){re.escape(VERSION)}(?![\d.])", actual):
        raise RuntimeError(f"Expected agent-device {VERSION}; found {actual}")
    return actual


def check_node():
    actual = capture(["node", "--version"])
    parts = tuple(int(part) for part in actual.lstrip("v").split(".")[:2])
    if parts < (22, 12):
        raise RuntimeError(f"Node 22.12+ required; found {actual}")
    return actual


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def device_json(config, topic):
    with tempfile.TemporaryDirectory(prefix="agent-device-check-") as temporary:
        output = Path(temporary) / "result.json"
        capture([
            "xcrun", "devicectl", "device", "info", topic,
            "--device", config["udid"], "--timeout", "10",
            "--json-output", str(output),
        ])
        return json.loads(output.read_text())["result"]


def check_target(config):
    if config["kind"] == "simulator":
        data = json.loads(capture(["xcrun", "simctl", "list", "devices", "--json"]))
        device = next((d for group in data["devices"].values() for d in group
                       if d["udid"] == config["udid"]), None)
        if not device or not device.get("isAvailable") or device["state"] != "Booted":
            raise RuntimeError("Selected simulator is missing, unavailable or not booted")
        return {"name": device["name"], "udid": device["udid"], "state": device["state"]}
    data = device_json(config, "details")
    hardware = data["hardwareProperties"]
    connection = data["connectionProperties"]
    properties = data["deviceProperties"]
    if hardware.get("udid") != config["udid"]:
        raise RuntimeError("Use the exact hardware UDID, not a device name or CoreDevice alias")
    if connection.get("pairingState") != "paired":
        raise RuntimeError("Selected device is not paired")
    if properties.get("developerModeStatus") != "enabled":
        raise RuntimeError("Selected device Developer Mode is not enabled")
    return {"name": properties.get("name"), "udid": hardware["udid"],
            "transport": connection.get("transportType"),
            "developerMode": properties["developerModeStatus"]}


def check_lock(config):
    data = device_json(config, "lockState")
    if data.get("passcodeRequired") or not data.get("unlockedSinceBoot"):
        raise RuntimeError("Unlock the selected iPhone on the device")
    return data


def check_developer_tools():
    output = capture(["/usr/sbin/DevToolsSecurity", "-status"])
    if "enabled" not in output.lower():
        raise RuntimeError(output)
    return output


def check_signing(config):
    if not (config.get("teamId") and config.get("runnerId")):
        raise RuntimeError("UI automation requires --team-id and --runner-id at init; launch does not")
    return "Runner signing identifiers configured; provisioning is not verified"


def preflight(root, config, automation=True):
    checks = {
        "xcode": lambda: capture(["xcodebuild", "-version"]),
        "target": lambda: check_target(config),
    }
    if automation:
        checks.update(cli=verify_version, node=check_node)
    if config["kind"] == "device":
        checks.update(lock=lambda: check_lock(config))
        if automation:
            checks.update(developerTools=check_developer_tools, signing=lambda: check_signing(config))
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(checks)) as pool:
        pending = {name: pool.submit(check) for name, check in checks.items()}
        for name, future in pending.items():
            try:
                results[name] = {"ok": True, "detail": future.result()}
            except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
                results[name] = {"ok": False, "error": str(error)}
    report = {"preflightOk": all(r["ok"] for r in results.values()),
              "purpose": "automation" if automation else "launch",
              "automationReady": False, "checks": results,
              "unchecked": ["runner provisioning/install quota", "UI Automation authorization",
                            "other XCTest users", "app build provenance"]}
    write_json(root / "preflight.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["preflightOk"] else 2


def simulator_pool(root, kind):
    if kind != "simulator":
        return None
    anchor = root
    while not anchor.exists() and anchor != anchor.parent:
        anchor = anchor.parent
    repo = None
    # A new/nonexistent task directory must not bypass the current project's policy.
    for directory in (Path.cwd(), anchor):
        result = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
                                capture_output=True, text=True)
        if result.returncode == 0:
            candidate = Path(result.stdout.strip())
            if (candidate / "packages/app-ios/ios/RunweaveNative.xcodeproj").exists():
                repo = candidate
                break
    if repo is None:
        return None
    path = repo / "scripts/ios-simulators/pool.py"
    if not path.exists():
        raise RuntimeError("This Runweave worktree needs the shared simulator tooling update")
    spec = importlib.util.spec_from_file_location("runweave_simulator_pool", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def launch_app(root, config):
    """Native launch only: wireless updates must not depend on XCTest readiness."""
    if config["kind"] != "device":
        raise RuntimeError("launch is for physical devices; simulators use the managed run entry")
    if preflight(root, config, automation=False):
        return 2
    stamp = str(time.time_ns())
    native = root / f"{stamp}-launch-native.json"
    started = time.monotonic()
    print("Launching installed App via CoreDevice; no XCTest or UI verification.", file=sys.stderr, flush=True)
    result = subprocess.run([
        "xcrun", "devicectl", "device", "process", "launch", "--device", config["udid"],
        "--timeout", "30", "--json-output", str(native), config["app"],
    ], capture_output=True, text=True, timeout=40)
    data = json.loads(native.read_text()) if native.exists() else {}
    pid = data.get("result", {}).get("process", {}).get("processIdentifier")
    code = result.returncode or (0 if type(pid) is int and pid > 0 else 2)
    report = {"command": "launch", "app": config["app"], "exit": code,
              "seconds": round(time.monotonic() - started, 3), "processIdentifier": pid,
              "automationReady": False, "uiVerified": False, "nativeResult": str(native)}
    write_json(root / f"{stamp}-launch.json", report)
    if native.exists():
        native.chmod(0o600)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if code:
        print("Native launch failed; inspect nativeResult. No automatic retry.", file=sys.stderr)
    return code


def runner_diagnostic(root, runner_log, offset, output):
    # Inspect only this invocation, not a failure left by an earlier runner.
    text = ""
    try:
        with runner_log.open("rb") as stream:
            size = runner_log.stat().st_size
            stream.seek(max(offset if size >= offset else 0, size - 256_000))
            text = stream.read().decode("utf-8", errors="replace")
    except OSError:
        pass
    markers = [marker for marker in (
        "exited with code 74", "Exiting due to IDE disconnection",
        "Failed to retrieve test configuration from IDE", "Connection peer refused channel request",
    ) if marker in text]
    if not markers and "xcodebuild exited early" not in output:
        return None
    transport = None
    try:
        transport = json.loads((root / "preflight.json").read_text())["checks"]["target"]["detail"].get("transport")
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    return {"code": "ios_xctest_bootstrap_failed" if markers else "ios_runner_exited_early",
            "transportAtPreflight": transport, "runnerLog": str(runner_log),
            "evidence": markers, "automationReady": False,
            "hint": "App launch and UI automation are separate. For launch-only use launch; "
                    "UI acceptance remains blocked. Inspect the runner log before retrying; "
                    "increasing a connection timeout cannot revive an exited runner."}


def invoke(root, config, command, private=False, daemon=False, operation=None):
    verify_version()
    env = os.environ.copy()
    env["AGENT_DEVICE_STATE_DIR"] = str(root / "state")
    env["AGENT_DEVICE_NO_UPDATE_NOTIFIER"] = "1"
    # Do not inherit another project's signing overrides.
    for key in ("AGENT_DEVICE_IOS_TEAM_ID", "AGENT_DEVICE_IOS_BUNDLE_ID",
                "AGENT_DEVICE_IOS_PROVISIONING_PROFILE", "AGENT_DEVICE_IOS_SIGNING_IDENTITY"):
        env.pop(key, None)
    if config["kind"] == "device":
        if not daemon and command[0] != "close":
            check_signing(config)
        if config.get("teamId") and config.get("runnerId"):
            env["AGENT_DEVICE_IOS_TEAM_ID"] = config["teamId"]
            env["AGENT_DEVICE_IOS_BUNDLE_ID"] = config["runnerId"]
    args = ["agent-device", *command]
    if not daemon:
        args.extend(["--session", config["session"], "--platform", "ios", "--udid", config["udid"]])
    started = time.monotonic()
    runner_log = root / "state" / "sessions" / config["session"] / "runner.log"
    runner_offset = runner_log.stat().st_size if runner_log.exists() else 0
    print(f"COMMAND_START {command[0]}: waiting for agent-device; UI commands may start XCTest.",
          file=sys.stderr, flush=True)
    if operation:
        operation.owner["automationPending"] = True
        operation.owner["automationStateDir"] = str(root / "state")
        # Persist intent before a daemon may be spawned outside this command's process group.
        pool = simulator_pool(root, config["kind"])
        pool.save_owner(operation.owner)
        result = operation.run(args, env=env, capture_output=True)
    else:
        result = subprocess.run(args, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
    output = result.stdout
    code = result.returncode
    # Pinned upstream CLI can return zero without a usable initial snapshot or settle result.
    if code == 0 and "initial interactive snapshot failed" in output:
        code = 2
    if code == 0 and "not settled after" in output:
        code = 3
    try:
        if code == 0 and json.loads(output).get("success") is False:
            code = 2
    except (ValueError, AttributeError):
        pass
    stamp = f"{time.time_ns()}-{uuid.uuid4().hex[:6]}"
    if not private:
        logfile = root / f"{stamp}.log"
        logfile.write_text(output)
        logfile.chmod(0o600)
    metric = {"id": stamp, "command": command[0], "seconds": round(time.monotonic() - started, 3),
              "upstreamExit": result.returncode, "exit": code, "outputSaved": not private}
    if code and not private and config["kind"] == "device":
        diagnostic = runner_diagnostic(root, runner_log, runner_offset, output)
        if diagnostic:
            write_json(root / f"{stamp}.diagnostic.json", diagnostic)
            metric["diagnostic"] = diagnostic["code"]
            print("AUTOMATION_DIAGNOSTIC " + json.dumps(diagnostic), file=sys.stderr)
    with (root / "metrics.jsonl").open("a") as stream:
        stream.write(json.dumps(metric) + "\n")
    (root / "metrics.jsonl").chmod(0o600)
    sys.stdout.write(output)
    print("COMMAND_RESULT " + json.dumps(metric), file=sys.stderr)
    if code != result.returncode:
        print("Observation incomplete. Inspect current state before any retry.", file=sys.stderr)
    return code


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init", help="Create a new local task; no device mutation")
    init.add_argument("root", type=Path)
    init.add_argument("--kind", choices=("device", "simulator"), required=True)
    init.add_argument("--udid", required=True)
    init.add_argument("--app", required=True)
    init.add_argument("--team-id")
    init.add_argument("--runner-id")
    for action in ("check", "stop", "launch"):
        sub.add_parser(action).add_argument("root", type=Path)
    run = sub.add_parser("run", help="Pass a CLI command after --; open uses the bound App")
    run.add_argument("root", type=Path)
    # REMAINDER keeps upstream flags untouched. A leading --private belongs to this wrapper.
    run.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    root = options.root.resolve()
    if options.action == "init":
        if bool(options.team_id) != bool(options.runner_id):
            parser.error("provide both --team-id and --runner-id, or neither for launch-only")
        if not re.fullmatch(r"[A-Za-z0-9-]+", options.udid):
            parser.error("invalid UDID")
        for value in (options.app, options.runner_id):
            if value and not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", value):
                parser.error("invalid Bundle ID")
        pool = simulator_pool(root, options.kind)
        if not pool:
            root.mkdir(parents=True, exist_ok=False)
        context = pool.operation(root, options.app, options.udid) if pool else nullcontext()
        with context:
            if (root / "session.json").exists():
                raise RuntimeError("Task already has a session; use a new task directory")
            config = {"kind": options.kind, "udid": options.udid, "app": options.app,
                      "teamId": options.team_id, "runnerId": options.runner_id,
                      "session": "qa-" + uuid.uuid4().hex[:12], "version": VERSION}
            write_json(root / "session.json", config)
        print(root)
        return 0
    config = json.loads((root / "session.json").read_text())
    if config.get("version") != VERSION:
        raise RuntimeError("Task was created for a different CLI version; create a new task")
    if options.action == "launch":
        return launch_app(root, config)
    pool = simulator_pool(root, config["kind"])
    context = pool.operation(root, config["app"], config["udid"]) if pool else nullcontext()
    with context as op:
        if options.action == "check":
            return preflight(root, config)
        if options.action == "stop":
            # Cleanup is allowed even after preflight failed; never stop another state directory.
            close_code = invoke(root, config, ["close"], operation=op)
            stop_code = invoke(root, config, ["daemon", "stop", "--state-dir", str(root / "state"), "--clean"], daemon=True, operation=op)
            return stop_code or close_code
        command = options.command
        private = bool(command and command[0] == "--private")
        if private:
            command = command[1:]
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            parser.error("run requires an agent-device command after --")
        forbidden = ("--session", "--platform", "--udid", "--device", "--state-dir", "--serial")
        if any(arg == flag or arg.startswith(flag + "=") for arg in command for flag in forbidden):
            parser.error("device/session overrides are fixed by init; create a separate task")
        if command[0] in ("daemon", "devices", "install", "reinstall", "uninstall"):
            parser.error("use stop for cleanup; installation/discovery uses explicit native tooling")
        if command[0] == "open":
            if len(command) > 1 and not command[1].startswith("-"):
                parser.error("open uses the App bound by init; do not pass another App")
            command.insert(1, config["app"])
        if command[0] == "open" and preflight(root, config):
            return 2
        return invoke(root, config, command, private, operation=op)



if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        code = getattr(error, "code", None)
        if code is not None:
            print(json.dumps({"ok": False, "code": code, "detail": str(error)},
                             ensure_ascii=False), file=sys.stderr)
            sys.exit(getattr(error, "exit_code", 2))
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(2)
