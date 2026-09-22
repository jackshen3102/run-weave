"""Inspect signed local products and retain evidence separately from source identity."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import uuid
from identity import APPS, directory, fingerprint, now, write

ROOT = Path(__file__).resolve().parents[2]


def inspect(app):
    value = json.loads((app / "BuildIdentity.json").read_text())
    if value.get("schemaVersion") != 1 or value.get("appId") not in APPS:
        raise ValueError("Unsupported build identity")
    uuid.UUID(value["buildId"])
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info["CFBundleIdentifier"] != value["bundleId"] or value["bundleId"] != APPS[value["appId"]][1]:
        raise ValueError("Bundle identity mismatch")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True, capture_output=True)
    digest = hashlib.sha256()
    for path in sorted(app.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(app).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    result = dict(identity=value, appPath=str(app), productSHA256=digest.hexdigest(), observedAt=now(), stage="signedProductObserved")
    write(directory(ROOT, value) / ("inspection-" + str(uuid.uuid4()) + ".json"), result)
    return result


def record_install(app, receipt_path, device):
    product = inspect(app)
    receipt = json.loads(receipt_path.read_text())
    installed = receipt.get("result", {}).get("installedApplications", [])
    success = (receipt.get("info", {}).get("outcome") == "success"
               and receipt.get("result", {}).get("deviceIdentifier") == device
               and any(x.get("bundleID") == product["identity"]["bundleId"] and x.get("installationURL") for x in installed))
    value = dict(at=now(), device=device, buildId=product["identity"]["buildId"],
                 productSHA256=product["productSHA256"], status="installed" if success else "failed",
                 receipt=receipt, receiptPath=str(receipt_path), runtimeObserved=False)
    write(directory(ROOT, product["identity"]) / ("install-" + str(uuid.uuid4()) + ".json"), value)
    if not success:
        raise ValueError("Installation receipt does not prove this bundle on the selected device")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["inspect", "record-install"]:
        item = commands.add_parser(name)
        item.add_argument("--app-path", type=Path, required=True)
        if name == "record-install":
            item.add_argument("--receipt", type=Path, required=True)
            item.add_argument("--device", required=True)
    item = commands.add_parser("lookup")
    item.add_argument("--build-id", required=True)
    args = parser.parse_args()
    if args.command == "lookup":
        uuid.UUID(args.build_id)
        matches = list((ROOT / ".runweave/ios-builds").glob("*/" + args.build_id + "/manifest.json"))
        if len(matches) != 1:
            raise ValueError("Build manifest missing or ambiguous")
        value = json.loads(matches[0].read_text())
        identity = value["identity"]
        value["sourceMatch"] = "matched" if fingerprint(ROOT, identity["appId"])[0] == identity["inputsSHA256"] else "different"
        value["sourceRestorable"] = False
    elif args.command == "inspect":
        value = inspect(args.app_path.resolve())
    else:
        value = record_install(args.app_path.resolve(), args.receipt.resolve(), args.device)
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("iOS artifact evidence: " + str(error), file=sys.stderr)
        sys.exit(1)
