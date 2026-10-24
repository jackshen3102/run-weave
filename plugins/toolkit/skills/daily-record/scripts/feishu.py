#!/usr/bin/env python3
"""Read-only Feishu candidate discovery and participation-scoped context via lark-cli."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


class Failure(Exception):
    pass


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp(value, zone):
    if str(value).isdigit():
        number = int(value)
        return datetime.fromtimestamp(number / (1000 if number > 10**11 else 1), timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)


class Capture:
    def __init__(self, out, zone, manifest):
        self.out = Path(out).expanduser().absolute()
        self.out.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.zone = zone
        self.manifest = {"schemaVersion": 1, "status": "collecting", "receipts": [],
                         "collectedAt": datetime.now(timezone.utc).isoformat(), **manifest}
        self.save_manifest()

    def save(self, name, value):
        raw = encoded(value)
        with (self.out / name).open("xb") as stream:
            stream.write(raw)
        return digest(raw)

    def save_manifest(self):
        (self.out / "manifest.json").write_bytes(encoded(self.manifest))

    def call(self, args, label, auth=False):
        env = {**os.environ, "TZ": self.zone.key,
               "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER": "1"}
        try:
            result = subprocess.run(["lark-cli", *args], capture_output=True, text=True,
                                    env=env, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure("LARK_CLI_UNAVAILABLE_OR_TIMEOUT") from None
        if result.returncode:
            raise Failure("LARK_CLI_FAILED: " + " ".join(args[:2]))
        value = json.loads(result.stdout)
        if auth:
            user = value.get("identities", {}).get("user", {})
            if (value.get("identity") != "user" or value.get("verified") is not True
                    or user.get("verified") is not True or user.get("tokenStatus") != "valid"
                    or not str(user.get("openId", "")).startswith("ou_")):
                raise Failure("VERIFIED_USER_AUTH_REQUIRED: run lark-cli auth status --json --verify")
            identity = {"openId": user["openId"], "name": user.get("userName")}
            self.manifest["identity"] = identity
            self.save_manifest()
            return identity  # Do not persist token/scopes/auth internals.
        if value.get("ok") is not True or value.get("identity") != "user":
            raise Failure("USER_READ_RESPONSE_REQUIRED")
        filename = label + ".json"
        sha = self.save(filename, value)
        self.manifest["receipts"].append({"file": filename, "sha256": sha, "argv": args})
        self.save_manifest()
        return value["data"]

    def pages(self, args, label, field, limit):
        token = None
        seen = set()
        for page in range(1, limit + 1):
            data = self.call(args + (["--page-token", token] if token else []), f"{label}-{page:03d}")
            rows = data[field]
            if not isinstance(rows, list) or not isinstance(data.get("has_more"), bool):
                raise Failure("INVALID_PAGE_RESPONSE")
            yield rows, data["has_more"]
            if not data["has_more"]:
                return
            token = data.get("page_token") or data.get("next_page_token")
            if not isinstance(token, str) or not token or token in seen:
                raise Failure("MISSING_OR_REPEATED_PAGE_TOKEN")
            seen.add(token)
        raise Failure("PAGE_LIMIT_REACHED: coverage is incomplete; inspect saved receipts")


def load_bundle(path):
    root = Path(path).expanduser().absolute()
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("kind") != "feishu-daily-candidates" or manifest.get("status") != "complete":
        raise Failure("COMPLETE_DISCOVERY_BUNDLE_REQUIRED")
    raw = (root / "messages.json").read_bytes()
    if digest(raw) != manifest["messagesSha256"]:
        raise Failure("DISCOVERY_MESSAGES_CHANGED")
    return manifest, json.loads(raw)


def discover(args, capture):
    start_day, end_day = date.fromisoformat(args.start), date.fromisoformat(args.to)
    if start_day.isoformat() != args.start or end_day.isoformat() != args.to or start_day > end_day:
        raise Failure("INVALID_DATE_RANGE")
    zone = capture.zone
    days = [start_day + timedelta(days=i) for i in range((end_day - start_day).days + 1)]
    start = datetime.combine(start_day, time.min, zone)
    end = datetime.combine(end_day + timedelta(days=1), time.min, zone)
    capture.manifest.update({"kind": "feishu-daily-candidates", "window": {
        "from": args.start, "to": args.to, "timeZone": zone.key,
        "start": start.isoformat(), "endExclusive": end.isoformat()},
        "channels": ["messages", "documents"] if args.channels == "all" else [args.channels],
        "documentScope": args.document_scope, "coverageMeaning": "API search results; not all historical activity"})
    capture.save_manifest()
    identity = capture.call(["auth", "status", "--json", "--verify"], "auth", auth=True)
    messages = {}
    omitted = 0
    command = ["im", "+messages-search", "--as", "user", "--query", "", "--sender", identity["openId"],
               "--start", start.isoformat(), "--end", end.isoformat(), "--page-size", "50", "--no-reactions"]
    message_pages = capture.pages(command, "self-messages", "messages", args.max_pages) if args.channels != "documents" else []
    for rows, _ in message_pages:
        for row in rows:
            if row.get("sender", {}).get("id") != identity["openId"] or not row.get("chat_id"):
                raise Failure("SELF_MESSAGE_FILTER_MISMATCH")
            when = stamp(row["create_time"], zone)
            if row.get("deleted") or not start <= when < end:
                omitted += 1
                continue
            messages[row["message_id"]] = row
    ordered = sorted(messages.values(), key=lambda row: (stamp(row["create_time"], zone), row["message_id"]))
    capture.manifest["messagesSha256"] = capture.save("messages.json", ordered)
    capture.manifest["messages"] = {"count": len(ordered), "omittedDeletedOrOutsideWindow": omitted,
                                    "chats": len({row["chat_id"] for row in ordered})}
    # my_edit_time is hour-aggregated. Full-day queries preserve the user's actual edit date;
    # last editor/update_time in result_meta does not establish that date.
    documents = {}
    for day in days if args.channels != "messages" else []:
        lo = datetime.combine(day, time.min, zone).isoformat()
        hi = datetime.combine(day + timedelta(days=1), time.min, zone).isoformat()
        for activity in ("created", "edited"):
            command = ["drive", "+search", "--as", "user", "--query", "", "--page-size", "20",
                       f"--{activity}-since", lo, f"--{activity}-until", hi]
            if activity == "created" or args.document_scope == "authored":
                command.append("--created-by-me")
            for rows, _ in capture.pages(command, f"docs-{day}-{activity}", "results", args.max_pages):
                for row in rows:
                    meta = row["result_meta"]
                    token = meta["token"]
                    item = documents.setdefault(token, {"token": token, "title": row["title_highlighted"],
                                                          "metadata": meta, "activities": []})
                    event = {"date": day.isoformat(), "kind": activity}
                    if event not in item["activities"]:
                        item["activities"].append(event)
    capture.manifest["documentsSha256"] = capture.save("documents.json", list(documents.values()))
    capture.manifest["documents"] = {"candidates": len(documents), "canonicalized": False}
    capture.manifest["status"] = "complete"
    capture.save_manifest()
    return {"bundle": str(capture.out), "messages": capture.manifest["messages"],
            "documents": capture.manifest["documents"], "status": "complete"}


def context(args, capture):
    manifest, messages = load_bundle(args.bundle)
    zone = ZoneInfo(manifest["window"]["timeZone"])
    capture.zone = zone
    seed = next((row for row in messages if row["message_id"] == args.message_id), None)
    if seed is None or seed.get("deleted") or seed["sender"]["id"] != manifest["identity"]["openId"]:
        raise Failure("OWN_DISCOVERED_MESSAGE_REQUIRED: arbitrary chats/threads cannot be expanded")
    capture.manifest.update({"kind": "feishu-selected-context", "seedId": args.message_id,
                             "chatId": seed["chat_id"], "discovery": str(Path(args.bundle).absolute())})
    identity = capture.call(["auth", "status", "--json", "--verify"], "auth", auth=True)
    if identity["openId"] != manifest["identity"]["openId"]:
        raise Failure("USER_IDENTITY_CHANGED")
    center = stamp(seed["create_time"], zone)
    lo = max(center - timedelta(minutes=args.minutes), stamp(manifest["window"]["start"], zone))
    hi = min(center + timedelta(minutes=args.minutes), stamp(manifest["window"]["endExclusive"], zone))
    command = ["im", "+threads-messages-list", "--thread", seed["thread_id"]] if seed.get("thread_id") else [
        "im", "+chat-messages-list", "--chat-id", seed["chat_id"], "--start", lo.isoformat(), "--end", hi.isoformat()]
    command += ["--as", "user", "--order", "desc", "--page-size", "50", "--no-reactions"]
    selected = {seed["message_id"]: seed}  # Thread APIs may omit the root; keep its search receipt.
    previous = None
    capture.manifest["window"] = {"start": lo.isoformat(), "endExclusive": hi.isoformat(),
                                   "timeZone": zone.key, "minutesAroundSeed": args.minutes}
    for rows, more in capture.pages(command, "context", "messages", args.max_pages):
        times = []
        for row in rows:
            if row.get("chat_id") != seed["chat_id"]:
                raise Failure("CONTEXT_CHAT_MISMATCH")
            if seed.get("thread_id") and row.get("thread_id") != seed["thread_id"]:
                raise Failure("CONTEXT_THREAD_MISMATCH")
            when = stamp(row["create_time"], zone)
            if previous is not None and when > previous:
                raise Failure("DESCENDING_ORDER_REQUIRED")
            previous = when
            times.append(when)
            if lo <= when < hi and not row.get("deleted"):
                selected[row["message_id"]] = row
        if times and min(times) < lo:
            capture.manifest["olderPagesOutsideWindow"] = more
            break
    result = sorted(selected.values(), key=lambda row: (stamp(row["create_time"], zone), row["message_id"]))
    capture.manifest["messagesSha256"] = capture.save("messages.json", result)
    capture.manifest.update({"status": "complete", "messages": len(result),
                             "coverageMeaning": "selected time window, not the complete conversation or task outcome"})
    capture.save_manifest()
    return {"bundle": str(capture.out), "seedId": args.message_id, "messages": len(result),
            "window": capture.manifest["window"], "status": "complete"}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    discovery = commands.add_parser("discover", help="Discover self messages and created/edited document candidates")
    discovery.add_argument("--from", dest="start", required=True, help="YYYY-MM-DD, inclusive")
    discovery.add_argument("--to", required=True, help="YYYY-MM-DD, inclusive")
    discovery.add_argument("--timezone", default="Asia/Shanghai")
    discovery.add_argument("--channels", choices=["all", "messages", "documents"], default="all",
                           help="Read only the requested Feishu sources")
    discovery.add_argument("--document-scope", choices=["authored", "edited"], default="edited",
                           help="edited includes created-by-me and edited-by-me; authored restricts both to original creator")
    expansion = commands.add_parser("context", help="Expand only a self-sent message from a completed discovery bundle")
    expansion.add_argument("--bundle", required=True)
    expansion.add_argument("--message-id", required=True)
    expansion.add_argument("--minutes", type=int, default=30, help="Time window each side of the selected self message (1-1440)")
    for command in (discovery, expansion):
        command.add_argument("--out", required=True, help="New protected output directory; never overwrite")
        command.add_argument("--max-pages", type=int, default=100)
    review = commands.add_parser("review", help="Read self message previews locally, without network")
    review.add_argument("--bundle", required=True)
    review.add_argument("--date")
    review.add_argument("--max-chars", type=int, default=1000)
    read = commands.add_parser("read", help="Read one full self message locally, without network")
    read.add_argument("--bundle", required=True)
    read.add_argument("--message-id", required=True)
    args = parser.parse_args()
    capture = None
    try:
        if args.command in ("review", "read"):
            manifest, rows = load_bundle(args.bundle)
            zone = ZoneInfo(manifest["window"]["timeZone"])
            if args.command == "read":
                rows = [row for row in rows if row["message_id"] == args.message_id]
                if not rows:
                    raise Failure("MESSAGE_NOT_FOUND")
                result = rows[0]
            else:
                if not 1 <= args.max_chars <= 100000:
                    raise Failure("INVALID_MAX_CHARS")
                result = [{**row, "content": row.get("content", "")[:args.max_chars],
                           "truncated": len(row.get("content", "")) > args.max_chars}
                          for row in rows if not args.date or stamp(row["create_time"], zone).date().isoformat() == args.date]
        else:
            if args.max_pages < 1 or (args.command == "context" and not 1 <= args.minutes <= 1440):
                raise Failure("INVALID_PAGE_OR_WINDOW_LIMIT")
            capture = Capture(args.out, ZoneInfo(args.timezone) if args.command == "discover" else ZoneInfo("UTC"), {})
            result = discover(args, capture) if args.command == "discover" else context(args, capture)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (Failure, OSError, ValueError, KeyError, TypeError) as error:
        # Failed reads never become an empty-day success. Do not print CLI stderr or auth secrets.
        message = str(error) if isinstance(error, Failure) else type(error).__name__
        if capture:
            capture.manifest.update({"status": "incomplete", "error": message})
            capture.save_manifest()
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
        return 2 if capture else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
