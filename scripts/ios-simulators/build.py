"""Worktree-local Xcode builds and verified simulator installation."""
from contextlib import nullcontext
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import json
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ios-build"))
from identity import fingerprint, directory as identity_directory

from pool import APPS, capture, devices, fail, guard, load_pool, now, operation, project, task, write


def cache_allowed():
    overrides = ("XCODE_XCCONFIG_FILE", "SDKROOT", "TOOLCHAINS", "DEVELOPER_DIR",
                 "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS")
    return not any(name in os.environ for name in overrides) and not any(
        name.startswith("SWIFT") or name.startswith("OTHER_SWIFT_FLAGS") for name in os.environ)


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


def product_sha256(app):
    digest = hashlib.sha256()
    for path in sorted(app.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(app).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def reusable_product(artifact_file, app, *, root, repository, app_name, configuration, inputs):
    if not cache_allowed():
        return None
    try:
        artifact = json.loads(artifact_file.read_text())
        identity = json.loads((app / "BuildIdentity.json").read_text())
        if (artifact.get("worktree") != str(root)
                or artifact.get("repositoryId") != repository
                or artifact.get("appPath") != str(app)
                or artifact.get("buildId") != identity.get("buildId")
                or artifact.get("configuration") != configuration
                or artifact.get("inputsSHA256") != inputs
                or artifact.get("identity") != identity
                or identity.get("appId") != app_name
                or identity.get("bundleId") != APPS[app_name]
                or identity.get("platform") != "iphonesimulator"
                or identity.get("configuration") != configuration
                or identity.get("inputsSHA256") != inputs
                or identity.get("xcodeVersion") != capture(["xcodebuild", "-version"])
                or identity.get("sdkVersion") != capture(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"])):
            return None
        if binary(app) != {"bundleId": APPS[app_name], "binarySHA256": artifact.get("binarySHA256")}:
            return None
        if product_sha256(app) != artifact.get("productSHA256"):
            return None
        return artifact
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def installed_product_matches(op, udid, app_name, app):
    result = op.run(["xcrun", "simctl", "get_app_container", udid, APPS[app_name], "app"], capture_output=True)
    if result.returncode:
        return False
    try:
        installed = Path(result.stdout.strip())
        return (binary(installed) == binary(app)
                and product_sha256(installed) == product_sha256(app)
                and (installed / "BuildIdentity.json").read_bytes() == (app / "BuildIdentity.json").read_bytes())
    except (OSError, ValueError, KeyError):
        return False


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
    artifact_file = build_root / f"artifact-{options.configuration}-iphonesimulator.json"
    build_guard = "build-" + hashlib.sha256(os.fsencode(build_root)).hexdigest()
    context = operation(options.task_dir, app_name, udid) if options.command == "run" else nullcontext()
    with context as op, guard(build_guard):
        def run(args, captured=False):
            result = op.run(args, cwd=root, capture_output=captured) if op else subprocess.run(
                args, cwd=root, text=True, stdout=subprocess.PIPE if captured else None)
            if result.returncode:
                fail("command_failed", f"{args[0]} exited {result.returncode}", 1)
            return result.stdout.strip() if captured else None
        before = fingerprint(root, app_name)[0]
        artifact = reusable_product(artifact_file, app, root=root, repository=repository,
                                    app_name=app_name, configuration=options.configuration, inputs=before)
        if artifact is None:
            artifact = reusable_product(build_root / "artifact.json", app, root=root, repository=repository,
                                        app_name=app_name, configuration=options.configuration, inputs=before)
            if artifact is not None:
                write(artifact_file, artifact)
        reused_build = artifact is not None
        if not reused_build:
            run(["xcodebuild", *flags, "-configuration", options.configuration,
                 "-destination", f"platform=iOS Simulator,id={udid}",
                 "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "build"])
            if before != fingerprint(root, app_name)[0]:
                fail("artifact_unverified", "Build inputs changed during compilation; rebuild before installation", 1)
        identity = json.loads((app / "BuildIdentity.json").read_text())
        if identity["inputsSHA256"] != before or identity["appId"] != app_name:
            fail("artifact_unverified", "Bundle build identity differs from input fingerprint", 1)
        evidence_dir = identity_directory(root, identity)
        if reused_build:
            write(evidence_dir / ("reuse-" + str(uuid.uuid4()) + ".json"),
                  {"buildId": identity["buildId"], "status": "source-and-product-matched", "at": now(), "appPath": str(app)})
        else:
            write(evidence_dir / "build-result.json", {"buildId": identity["buildId"], "status": "built", "at": now(), "appPath": str(app)})
            artifact = {"buildId": identity["buildId"], "identity": identity,"worktree": str(root), "repositoryId": repository,
                        "head": capture(["git", "rev-parse", "HEAD"], root),
                        "inputsSHA256": before, "configuration": options.configuration,
                        "appPath": str(app), "builtAt": now(), **binary(app), "productSHA256": product_sha256(app)}
            if artifact["bundleId"] != APPS[app_name]:
                fail("artifact_unverified", "Built bundle ID differs from the selected App", 1)
            if cache_allowed():
                write(artifact_file, artifact)
                write(build_root / "artifact.json", artifact)
        if op:
            if device["state"] != "Booted":
                run(["xcrun", "simctl", "boot", udid])
            run(["xcrun", "simctl", "bootstatus", udid, "-b"])
            receipt = {"buildId": identity["buildId"], "device": udid, "at": now(), "runtimeObserved": False}
            receipt_file = evidence_dir / ("install-" + str(uuid.uuid4()) + ".json")
            reused_install = installed_product_matches(op, udid, app_name, app)
            if not reused_install:
                try:
                    run(["xcrun", "simctl", "install", udid, str(app)])
                except BaseException:
                    write(receipt_file, {**receipt, "status": "failed"})
                    raise
            installed = Path(run(["xcrun", "simctl", "get_app_container", udid, APPS[app_name], "app"], True))
            if (binary(installed) != binary(app)
                    or product_sha256(installed) != artifact["productSHA256"]
                    or (installed / "BuildIdentity.json").read_bytes() != (app / "BuildIdentity.json").read_bytes()):
                fail("artifact_unverified", "Installed App differs from this worktree's build", 1)
            write(receipt_file, {**receipt, "status": "verified-existing" if reused_install else "installed",
                                 "binarySHA256": artifact["binarySHA256"], "productSHA256": artifact["productSHA256"]})
            task_artifact = {**artifact, "udid": udid, "lease": op.owner["lease"],
                             "verifiedAt": now(), "reusedBuild": reused_build, "reusedInstall": reused_install}
            if not reused_install:
                task_artifact["installedAt"] = now()
            write(Path(options.task_dir) / "installed-app.json", task_artifact)
            run(["xcrun", "simctl", "launch", udid, APPS[app_name]])
            return {"code": "installed", **task_artifact}
    return {"code": "built", **artifact, "reusedBuild": reused_build}
