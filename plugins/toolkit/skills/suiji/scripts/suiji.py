#!/usr/bin/env python3
"""Portable Suiji client. No automatic business-write retry."""
import argparse
import hashlib
import http.client
import json
import os
import re
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class Failure(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Failure("REDIRECT_REJECTED")


def endpoint(value):
    url = urllib.parse.urlsplit(value.strip())
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise Failure("INVALID_ENDPOINT")
    if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise Failure("REMOTE_HTTPS_REQUIRED")
    host = "[::1]" if url.hostname == "::1" else url.hostname.lower()
    port = url.port
    if port and port != (443 if url.scheme == "https" else 80):
        host += ":" + str(port)
    return urllib.parse.urlunsplit((url.scheme, host, url.path.rstrip("/"), "", ""))


def private_read(path):
    path = Path(path)
    if path.is_symlink() or (os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077):
        raise Failure("PRIVATE_FILE_REQUIRED: " + str(path))
    return path.read_bytes()


def exclusive_write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


class Client:
    def __init__(self, config):
        self.config = config
        self.base = endpoint(config["endpoint"])
        for key in ("serverId", "ownerId"):
            uuid.UUID(config[key])
        self.token = os.environ.get(config["tokenEnv"])
        if not self.token:
            raise Failure("MISSING_TOKEN_ENV: " + config["tokenEnv"])
        self.opener = urllib.request.build_opener(NoRedirect)
        self.protocol = "2025-03-26"

    def request(self, route, data, content_type="application/json", key=None):
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": content_type,
                   "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": self.protocol}
        if key:
            headers["Idempotency-Key"] = key
        req = urllib.request.Request(self.base + route, data=data, headers=headers, method="POST")
        try:
            with self.opener.open(req, timeout=60) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            # Do not echo headers or private request bodies.
            raise Failure("HTTP_" + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException):
            raise Failure("NETWORK_RESULT_UNKNOWN; keep the original request for manual retry") from None

    def rpc(self, method, params):
        payload = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}
        value = self.request("/mcp", json.dumps(payload).encode())
        if "error" in value:
            raise Failure("MCP_PROTOCOL_ERROR: " + str(value["error"].get("code")))
        return value["result"]

    def call(self, name, arguments):
        value = self.rpc("tools/call", {"name": name, "arguments": arguments})
        structured = value.get("structuredContent")
        if value.get("isError"):
            if structured is None:
                raise Failure("MCP_TOOL_ERROR")
            raise Failure(str(structured.get("error", {}).get("code", "MCP_TOOL_ERROR")))
        if any(block.get("type") == "image" for block in value.get("content", [])):
            return value
        return structured if structured is not None else value

    def verify(self):
        initialization = self.rpc("initialize", {"protocolVersion": self.protocol, "capabilities": {}, "clientInfo": {"name": "suiji-skill", "version": "1.0"}})
        self.protocol = initialization["protocolVersion"]
        self.request("/mcp", json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode())
        info = self.call("get_service_info", {})
        if any(info.get(key) != self.config[key] for key in ("serverId", "ownerId")):
            raise Failure("SERVICE_IDENTITY_MISMATCH")
        if not info.get("features", {}).get("followups"):
            raise Failure("FOLLOWUPS_UNAVAILABLE")
        return info

    def followups(self, record_id):
        items, cursor = [], None
        while True:
            args = {"recordId": record_id}
            if cursor:
                args["cursor"] = cursor
            page = self.call("list_followups", args)
            items.extend(page["items"])
            cursor = page.get("nextCursor")
            if not cursor:
                return {"items": items, "nextCursor": None}


def run_intent(client, path, intent):
    expected = {key: client.config[key] for key in ("serverId", "ownerId")}
    expected["endpoint"] = client.base
    if intent["identity"] != expected:
        raise Failure("REQUEST_IDENTITY_MISMATCH")
    if intent["operation"] == "upload":
        snapshot = Path(str(path) + ".attachment")
        data = private_read(snapshot)
        if hashlib.sha256(data).hexdigest() != intent["sha256"]:
            raise Failure("FROZEN_UPLOAD_CHANGED")
        boundary = uuid.uuid4().hex
        name = intent["fileName"].replace('"', "_").replace("\r", "_").replace("\n", "_")
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {intent["mime"]}\r\n\r\n').encode() + data + f"\r\n--{boundary}--\r\n".encode()
        result = client.request("/mcp/uploads", body, "multipart/form-data; boundary=" + boundary, intent["key"])
        if not result.get("attachment", {}).get("id"):
            raise Failure("INVALID_UPLOAD_RESPONSE; original request retained")
    else:
        result = client.call(intent["operation"], intent["arguments"])
        if intent["operation"] == "append_followup":
            followup = result.get("followup", {})
            args = intent["arguments"]
            if not followup.get("id") or followup.get("recordId") != args["recordId"] or followup.get("body") != args["body"] or [a["id"] for a in followup.get("attachments", [])] != args.get("attachmentIds", []):
                raise Failure("INVALID_FOLLOWUP_RESPONSE; original request retained")
        elif result.get("record", {}).get("taskStatus") != "done":
            raise Failure("INVALID_STATUS_RESPONSE; original request retained")
    Path(path).unlink()
    if intent["operation"] == "upload":
        snapshot.unlink()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--env-file", help="Protected 0600 file containing only the configured token variable")
    parser.add_argument("command", choices=["info", "list", "search", "get", "followups", "handoff", "read-attachment", "upload", "append", "complete", "retry"])
    for option in ("record-id", "attachment-id", "query", "tag", "status", "kind", "cursor", "input", "request", "file"):
        parser.add_argument("--" + option)
    args = parser.parse_args()
    inputs = None
    if args.command == "append":
        # Bind before networking and reuse this payload without rereading the file.
        if not args.record_id:
            raise Failure("RECORD_ID_REQUIRED: pass the selected target via --record-id")
        uuid.UUID(args.record_id)
        inputs = json.loads(Path(args.input).read_text())
        if not isinstance(inputs, dict) or set(inputs) - {"recordId", "body", "attachmentIds", "agentName", "sessionId"}:
            raise Failure("UNKNOWN_APPEND_FIELDS")
        if inputs.get("recordId") != args.record_id:
            raise Failure("APPEND_TARGET_MISMATCH; do not submit this result file")
    config = json.loads(private_read(args.config))
    target = None
    if args.command == "handoff":
        raw = Path(args.input).read_text()
        target = json.loads(raw[raw.index("{"):])
        if target.get("format") != "suiji-handoff-v1" or endpoint(target["endpoint"]) != endpoint(config["endpoint"]) or any(target[key] != config[key] for key in ("serverId", "ownerId")):
            raise Failure("HANDOFF_IDENTITY_MISMATCH; configure the target connection")
        args.record_id = target["recordId"]
    if args.env_file:
        lines = private_read(args.env_file).decode("utf-8").splitlines()
        entries = [line for line in lines if line.strip()]
        if len(entries) != 1:
            raise Failure("INVALID_TOKEN_FILE")
        key, separator, token = entries[0].partition("=")
        if not separator or key != config["tokenEnv"] or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise Failure("INVALID_TOKEN_FILE")
        existing = os.environ.get(key)
        if existing is not None and existing != token:
            raise Failure("TOKEN_SOURCE_CONFLICT")
        os.environ[key] = token
    client = Client(config)
    info = client.verify()
    if args.command == "info":
        return info
    if args.command in ("list", "search"):
        inputs = {key: value for key, value in {"kind": args.kind, "taskStatus": args.status, "tag": args.tag, "cursor": args.cursor}.items() if value is not None}
        if args.command == "search":
            inputs["query"] = args.query
        return client.call(args.command + "_records", inputs)
    if args.command in ("get", "followups", "handoff", "complete", "upload"):
        uuid.UUID(args.record_id)
    if args.command == "get":
        return client.call("get_record", {"recordId": args.record_id})
    if args.command == "followups":
        return client.followups(args.record_id)
    if args.command == "handoff":
        return {**client.call("get_record", {"recordId": args.record_id}), "followups": client.followups(args.record_id)["items"]}
    if args.command == "read-attachment":
        inputs = {"attachmentId": args.attachment_id}
        if args.cursor:
            inputs["cursor"] = args.cursor
        return client.call("read_attachment", inputs)
    if not args.request:
        raise Failure("REQUEST_FILE_REQUIRED")
    if args.command == "retry":
        intent = json.loads(private_read(args.request))
        return run_intent(client, args.request, intent)
    if Path(args.request).exists():
        raise Failure("REQUEST_EXISTS; use explicit retry with original parameters")
    intent = {"identity": {"endpoint": client.base, "serverId": config["serverId"], "ownerId": config["ownerId"]}}
    key = str(uuid.uuid4())
    if args.command == "upload":
        client.call("get_record", {"recordId": args.record_id})
        file = Path(args.file)
        data = file.read_bytes()
        mime = {".md": "text/markdown", ".markdown": "text/markdown", ".mdown": "text/markdown", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(file.suffix.lower())
        if not mime or not data or len(data) > 5 * 1024 * 1024:
            raise Failure("INVALID_UPLOAD_FILE")
        intent.update(operation="upload", key=key, recordId=args.record_id, fileName=file.name, mime=mime, sha256=hashlib.sha256(data).hexdigest())
        exclusive_write(args.request + ".attachment", data)
    elif args.command == "append":
        inputs["idempotencyKey"] = key
        intent.update(operation="append_followup", arguments=inputs)
    else:
        record = client.call("get_record", {"recordId": args.record_id})["record"]
        if record["taskStatus"] == "done":
            return {"record": record, "alreadyDone": True}
        intent.update(operation="set_task_status", arguments={"recordId": args.record_id, "expectedVersion": record["version"], "targetStatus": "done", "idempotencyKey": key})
    exclusive_write(args.request, json.dumps(intent, ensure_ascii=False).encode())
    return run_intent(client, args.request, intent)


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except (Failure, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
