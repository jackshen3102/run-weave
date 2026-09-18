"""Worktree-local Xcode builds and verified simulator installation."""
from contextlib import nullcontext
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess

from pool import APPS, capture, devices, fail, guard, load_pool, now, operation, project, task, write


def inputs(paths):
    digest = hashlib.sha256()
    for base in paths:
        def visit(path):
            if path.name in (".git", ".build", ".swiftpm", "xcuserdata", "__pycache__"):
                return
            if path.is_symlink():
                fail("artifact_unverified", f"Build input symlink is not supported: {path}", 1)
            if path.is_dir():
                for child in sorted(path.iterdir()):
                    visit(child)
            elif path.is_file():
                digest.update(str(path.relative_to(base.parent)).encode() + b"\0")
                digest.update(str(path.stat().st_mode).encode() + b"\0")
                digest.update(path.read_bytes())
            else:
                digest.update(str(path.relative_to(base.parent)).encode() + b"\0")
                digest.update(b"missing")
        visit(base)
    return digest.hexdigest()


def binary(app):
    with (app / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    name = info["CFBundleExecutable"]
    if Path(name).name != name:
        fail("artifact_unverified", "Invalid executable in app bundle", 1)
    # Debug dylibs contain the application code on current Xcode; hash them too.
    files = sorted({app / name, *app.glob("*.dylib"), *app.glob("Frameworks/**/*")})
    digest = hashlib.sha256()
    for path in files:
        if path.is_file():
            digest.update(str(path.relative_to(app)).encode() + b"\0")
            digest.update(path.read_bytes())
    return {"bundleId": info["CFBundleIdentifier"], "binarySHA256": digest.hexdigest()}


def run_app(options):
    root, repository = project()
    app_name = options.app
    package = root / "packages" / ("app-ios" if app_name == "runweave" else "suiji-ios")
    scheme = "RunweaveNative" if app_name == "runweave" else "Suiji"
    build_root = package / ".build/ios" if app_name == "runweave" else root / ".runweave/suiji/ios-build"
    flags = ["-project", str(package / "ios" / f"{scheme}.xcodeproj"), "-scheme", scheme,
             "-derivedDataPath", str(build_root / "DerivedData"),
             "-clonedSourcePackagesDirPath", str(build_root / "SourcePackages"),
             "-packageCachePath", str(build_root / "PackageCache")]
    if options.command == "doctor":
        for args in (["xcodebuild", "-version"], ["xcodebuild", "-showsdks"],
                     ["xcrun", "simctl", "list", "runtimes"], ["xcodebuild", *flags, "-showdestinations"]):
            print(capture(args, package))
        return {"code": "doctor_completed"}
    if options.command == "run":
        if not options.task_dir:
            fail("lease_mismatch", "run requires --task-dir from simulator pool start", 2)
        owner = task(options.task_dir, app_name, options.simulator)
        if owner["worktree"] != str(root):
            fail("lease_mismatch", "Install from the worktree that owns the task", 2)
        udid = owner["udid"]
    else:
        udid = options.simulator or load_pool(repository)["slots"][app_name]["udid"]
    device = devices().get(udid)
    if not device or not device.get("isAvailable"):
        fail("pool_device_missing", "Simulator is unavailable", 2)
    app = build_root / f"DerivedData/Build/Products/{options.configuration}-iphonesimulator/{scheme}.app"
    build_guard = "build-" + hashlib.sha256(os.fsencode(build_root)).hexdigest()
    context = operation(options.task_dir, app_name, udid) if options.command == "run" else nullcontext()
    with context as op, guard(build_guard):
        def run(args, captured=False):
            result = op.run(args, cwd=root, capture_output=captured) if op else subprocess.run(
                args, cwd=root, text=True, stdout=subprocess.PIPE if captured else None)
            if result.returncode:
                fail("command_failed", f"{args[0]} exited {result.returncode}", 1)
            return result.stdout.strip() if captured else None
        paths = [package / "Package.swift", package / "Package.resolved", package / "Sources",
                 package / "ios", root / "packages/browser-ios"]
        if app_name == "runweave":
            paths.append(package / "Vendor")
        before = inputs(paths)
        run(["xcodebuild", *flags, "-configuration", options.configuration,
             "-destination", f"platform=iOS Simulator,id={udid}",
             "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "build"])
        if before != inputs(paths):
            fail("artifact_unverified", "Build inputs changed during compilation; rebuild before installation", 1)
        artifact = {"worktree": str(root), "repositoryId": repository,
                    "head": capture(["git", "rev-parse", "HEAD"], root),
                    "inputsSHA256": before, "configuration": options.configuration,
                    "appPath": str(app), "builtAt": now(), **binary(app)}
        if artifact["bundleId"] != APPS[app_name]:
            fail("artifact_unverified", "Built bundle ID differs from the selected App", 1)
        write(build_root / "artifact.json", artifact)
        if op:
            if device["state"] != "Booted":
                run(["xcrun", "simctl", "boot", udid])
            run(["xcrun", "simctl", "bootstatus", udid, "-b"])
            run(["xcrun", "simctl", "install", udid, str(app)])
            installed = Path(run(["xcrun", "simctl", "get_app_container", udid, APPS[app_name], "app"], True))
            if binary(installed) != binary(app):
                fail("artifact_unverified", "Installed executable differs from this worktree's build", 1)
            artifact.update(udid=udid, lease=op.owner["lease"], installedAt=now())
            write(Path(options.task_dir) / "installed-app.json", artifact)
            run(["xcrun", "simctl", "launch", udid, APPS[app_name]])
    return {"code": "installed" if options.command == "run" else "built", **artifact}
