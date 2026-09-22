"""Source identity shared by Xcode schemes and local artifact inspection (stdlib only)."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone

APPS = {"runweave": ("app-ios", "com.runweave.app.native"), "suiji": ("suiji-ios", "com.runweave.suiji")}
EXCLUDED = {".git", ".build", ".swiftpm", "DerivedData", "xcuserdata", "__pycache__", ".DS_Store"}


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def command(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def roots(root, app):
    package = root / "packages" / APPS[app][0]
    paths = [package / "Package.swift", package / "Package.resolved", package / "Sources", package / "ios",
             root / "scripts/ios-build"]
    for name in ["browser-ios", "ios-build-identity"]:
        paths += [root / "packages" / name / "Package.swift", root / "packages" / name / "Sources"]
    if app == "runweave":
        paths.append(package / "Vendor")
    return paths


def fingerprint(root, app):
    digest = hashlib.sha256(b"runweave-ios-inputs-v1\0")
    files = []
    def visit(path):
        if path.name in EXCLUDED:
            return
        if path.is_symlink():
            raise ValueError("Unsupported build input symlink: " + str(path.relative_to(root)))
        if path.is_dir():
            for child in sorted(path.iterdir()):
                visit(child)
        else:
            relative = path.relative_to(root).as_posix()
            files.append(relative)
            digest.update(relative.encode() + b"\0")
            if not path.exists():
                digest.update(b"missing\0")
            else:
                if not path.is_file():
                    raise ValueError("Unsupported input: " + relative)
                digest.update(str(stat.S_IMODE(path.stat().st_mode) & 0o111).encode() + b"\0")
                digest.update(hashlib.sha256(path.read_bytes()).digest())
    for path in roots(root, app):
        visit(path)
    return digest.hexdigest(), files


def git_identity(root, app):
    try:
        if Path(command(["git", "rev-parse", "--show-toplevel"], root)).resolve() != root:
            return None, "unknown"
        revision = command(["git", "rev-parse", "HEAD"], root)
        paths = [str(p.relative_to(root)) for p in roots(root, app)]
        # Git honors ignored local signing/user files; source files remain covered by the content hash.
        changed = command(["git", "diff", "--name-only", "-z", "HEAD", "--", *paths], root).split("\0")
        untracked = command(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", *paths], root).split("\0")
        dirty = any(name and not EXCLUDED.intersection(Path(name).parts) for name in changed + untracked)
        return revision, "modified" if dirty else "clean"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None, "unknown"


def directory(root, identity):
    return root / ".runweave/ios-builds" / identity["appId"] / identity["buildId"]


def phase(action, app):
    env = os.environ
    root = Path(env["PROJECT_DIR"]).resolve().parents[2]
    slot = Path(env["BUILD_DIR"]) / ".runweave-identity" / (app + "-" + env["CONFIGURATION"] + "-" + env["PLATFORM_NAME"] + ".json")
    if action == "begin":
        slot.unlink(missing_ok=True)
        digest, files = fingerprint(root, app)
        revision, state = git_identity(root, app)
        identity = dict(schemaVersion=1, fingerprintVersion=1, buildId=str(uuid.uuid4()), appId=app,
                        bundleId=APPS[app][1], sourceRevision=revision, sourceState=state,
                        inputsSHA256=digest, builtAt=now(), configuration=env["CONFIGURATION"],
                        platform=env["PLATFORM_NAME"], architecture=env.get("ARCHS", "unknown"),
                        xcodeVersion=command(["xcodebuild", "-version"]), sdkVersion=env.get("SDK_VERSION", "unknown"))
        value = dict(identity=identity, worktree=str(root), inputs=files, stage="inputsCaptured")
        write(directory(root, identity) / "manifest.json", value)
        write(slot, value)
    elif action == "finish":
        # Consume the scheme pre-action exactly once; a bypassed/failed pre-action cannot reuse a stamp.
        value = json.loads(slot.read_text())
        slot.unlink()
        identity = value["identity"]
        if value["worktree"] != str(root) or identity["inputsSHA256"] != fingerprint(root, app)[0]:
            raise ValueError("Build inputs changed during compilation; rebuild stable sources")
        if identity["sourceRevision"] != git_identity(root, app)[0]:
            raise ValueError("Git revision changed during compilation")
        if identity["configuration"] != env["CONFIGURATION"] or identity["platform"] != env["PLATFORM_NAME"]:
            raise ValueError("Build identity context mismatch")
        product = Path(env["TARGET_BUILD_DIR"]) / env["UNLOCALIZED_RESOURCES_FOLDER_PATH"]
        write(product / "BuildIdentity.json", identity)
        value.update(stage="inputsVerified", appPath=str(product), verifiedAt=now())
        write(directory(root, identity) / "manifest.json", value)
    else:
        raise ValueError("Unknown phase")


if __name__ == "__main__":
    try:
        phase(sys.argv[1], sys.argv[2])
    except Exception as error:
        print("error: iOS build identity: " + str(error), file=sys.stderr)
        sys.exit(1)
