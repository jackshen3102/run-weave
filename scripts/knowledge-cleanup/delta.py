#!/usr/bin/env python3
"""Local Stable cleanup reader. The only writes are private run files and progress."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

KINDS = ("records", "revisions", "candidates", "jobs")
TASK = "e94deff0-2a1e-40da-88e7-9b5b75d263b0"
FORMAT = 1


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def load(file):
    return json.loads(file.read_text())


def save(file, value, *, replace=False):
    fd, path = tempfile.mkstemp(dir=file.parent, prefix=".cleanup-")
    try:
        with os.fdopen(fd, "w") as output:
            output.write(encode(value) + "\n")
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(path, file)
        else:
            os.link(path, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(path).unlink(missing_ok=True)


@contextlib.contextmanager
def snapshot(path):
    with contextlib.closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        yield db


def rw(*args):
    binary = os.environ.get("RUNWEAVE_CLI_BIN") or "rw"
    result = subprocess.run([binary, *args, "--instance", "stable", "--json"],
                            check=True, text=True, stdout=subprocess.PIPE, timeout=60)
    return json.loads(result.stdout)


def stable_sources():
    health = rw("health")
    instance = health["health"]["environment"]
    if not health["authenticated"] or not health["reachable"] or instance["kind"] != "stable":
        raise ValueError("Authenticated local Stable Backend is required")
    if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]+", health["baseUrl"]):
        raise ValueError("Stable Backend must be a local loopback origin")
    root = Path(instance["configRoot"]).resolve(strict=True)
    experience = Path(rw("config", "explain", "storage.experienceDirectory")["resolved"]["value"])
    evolution = Path(rw("config", "explain", "storage.evolutionDirectory")["resolved"]["value"])
    repositories = rw("evolution", "repository", "list", "--include-removed")["repositories"]
    return root, health["baseUrl"], experience / "production", evolution / "learning.sqlite", repositories


def moment():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def milliseconds(instant):
    return round(datetime.fromisoformat(instant.replace("Z", "+00:00")).timestamp() * 1000)


def exp_key(repo, kind, identity):
    return f"experience/{repo}/{kind}/{identity}"


def read_experience(home, repos, emit):
    for location in [*repos, "_queue"]:
        file = home / location / "store.sqlite"
        if not file.is_file():
            continue
        with snapshot(file) as db:
            identity = (file.stat().st_dev, file.stat().st_ino)
            if location == "_queue":
                # The queue shares one DB across registered repositories.
                for key, rowid in db.execute("SELECT id,rowid FROM documents WHERE bucket='jobs'"):
                    read_document(db, emit, f"experience/jobs/{key}", "jobs", identity, rowid)
                continue
            # The (bucket,id) index supplies rowid too. Only a changed row or a
            # one-time legacy-baseline comparison needs to read the JSON value.
            rows = db.execute("""SELECT bucket,id,rowid FROM documents
                                WHERE bucket IN ('records','revisions','candidates')""")
            source = [repos[location].get("available"), repos[location].get("removed")]
            for kind, key, rowid in rows:
                read_document(db, emit, exp_key(location, kind, key), kind, [*identity, *source], rowid)


def read_document(db, emit, key, kind, identity, rowid):
    def stored():
        return db.execute("SELECT value FROM documents WHERE rowid=?", (rowid,)).fetchone()[0]

    def logical():
        value = json.loads(stored())
        if kind == "candidates":
            return candidate_baseline(value)
        return value["updatedAt" if kind == "jobs" else "revision"]

    def body():
        raw = stored()
        value = json.loads(raw)
        if kind == "candidates":
            return {"candidate": value, "version": hashlib.sha256(raw.encode()).hexdigest()}
        if kind == "jobs":
            for field in ("source", "claim", "leaseUntil", "sourceDigest"):
                value.pop(field, None)
        return value

    emit(key, [*identity, rowid], logical, body)


def candidate_baseline(value):
    return [value["record"]["revision"], value["status"], value["review"], value.get("retirement")]


def read_evolution(file, emit):
    with snapshot(file) as db:
        attribution = {
            (kind, key): json.loads(data)
            for kind, key, data in db.execute("SELECT kind,id,payload_json FROM evolution_repository_bindings")
        }
        for key, updated in db.execute("SELECT run_id,updated_at_ms FROM evolution_runs"):
            version = [updated, attribution.get(("run", key))]

            def run():
                repository, stage, outcome = db.execute(
                    "SELECT repository_json,stage,outcome FROM evolution_runs WHERE run_id=?", (key,)
                ).fetchone()
                return {"runId": key, "repository": json.loads(repository or "null"),
                        "attribution": version[1], "stage": stage, "outcome": outcome}

            emit(f"evolution/runs/{key}", version, version, run)
        for key, revision, updated, canonical, status in db.execute(
            """SELECT insight_id,current_revision_id,updated_at,canonical_insight_id,status
               FROM insights LEFT JOIN evolution_topic_lineage ON legacy_insight_id=insight_id"""
        ):
            lineage = {"canonicalInsightId": canonical, "status": status} if canonical else None
            version = [revision, updated, attribution.get(("insight", key)), lineage]

            def insight():
                topic, scope = db.execute(
                    "SELECT topic_key,learning_scope_id FROM insights WHERE insight_id=?", (key,)
                ).fetchone()
                row = db.execute("SELECT payload_json FROM insight_revisions WHERE revision_id=?", (revision,)).fetchone()
                return {"insightId": key, "topicKey": topic, "learningScopeId": scope,
                        "currentRevision": json.loads(row[0]) if row else None,
                        "attribution": version[2], "lineage": lineage}

            emit(f"evolution/insights/{key}", version, version, insight)
        for key, insight_id in db.execute("SELECT revision_id,insight_id FROM insight_revisions"):
            def revision_body():
                raw, = db.execute("SELECT payload_json FROM insight_revisions WHERE revision_id=?", (key,)).fetchone()
                return {"insightId": insight_id, "revision": json.loads(raw)}

            emit(f"evolution/insight-revisions/{key}", insight_id, insight_id, revision_body)
        for key, revision in db.execute(
            """SELECT asset_id,revision_id FROM (
                 SELECT asset_id,revision_id,row_number() OVER (
                   PARTITION BY asset_id ORDER BY updated_at DESC,rowid DESC
                 ) AS rank FROM candidate_asset_revisions
               ) WHERE rank=1"""
        ):
            version = [revision, attribution.get(("candidate", key))]

            def candidate():
                raw, = db.execute("SELECT payload_json FROM candidate_asset_revisions WHERE revision_id=?", (revision,)).fetchone()
                return {**json.loads(raw), "attribution": version[1]}

            emit(f"evolution/candidates/{key}", version, version, candidate)


def read_inbox(file, emit):
    with snapshot(file) as db:
        # State rows are metadata. Keep only per-item fingerprints, never user identities.
        states = {}
        for item, version, state, processed in db.execute(
            "SELECT item_id,version,state_version,processed_at FROM user_state ORDER BY username,version"
        ):
            states.setdefault(item, []).append([version, state, processed])
        for item, available, content, source_revision in db.execute(
            """SELECT item_id,available,json_extract(payload,'$.contentVersion'),
                      json_extract(payload,'$.sourceRevision') FROM catalog"""
        ):
            logical = [available, content, source_revision]

            def body():
                raw, = db.execute("SELECT payload FROM catalog WHERE item_id=?", (item,)).fetchone()
                return {**json.loads(raw), "catalogAvailable": bool(available)}

            emit(f"inbox/{item}", [*logical, states.get(item, [])], logical, body)


def inventory(experience, evolution, inbox, repos, previous):
    versions = {}
    items = {}

    def emit(key, version, logical, body):
        fingerprint = digest(version)
        versions[key] = fingerprint
        old = previous.get(key)
        if old == fingerprint:
            return
        if old and old.startswith("baseline:") and old == "baseline:" + digest(
            logical() if callable(logical) else logical
        ):
            return
        items[key] = body()

    read_experience(experience, repos, emit)
    read_evolution(evolution, emit)
    read_inbox(inbox, emit)
    for key in previous.keys() - versions.keys():
        items[key] = None
    return versions, items


def seed(evidence):
    versions = {}

    def put(key, value):
        versions[key] = "baseline:" + digest(value)

    for kind in KINDS:
        files = sorted(evidence.glob(f"after-{kind}-*.json"))
        if not files:
            raise ValueError(f"Missing audited {kind} inventory")
        for file in files:
            repo = file.stem.rsplit("-", 1)[1]
            for row in load(file):
                if kind == "candidates":
                    item = row["candidate"]
                    key = item["candidateId"]
                    token = candidate_baseline(item)
                else:
                    key = row[{"records": "id", "revisions": "revision", "jobs": "jobId"}[kind]]
                    token = row["updatedAt"] if kind == "jobs" else row["revision"]
                put(f"experience/jobs/{key}" if kind == "jobs" else exp_key(repo, kind, key), token)
    for row in load(evidence / "after-evolution-runs.json"):
        put(f'evolution/runs/{row["runId"]}', [milliseconds(row["updatedAt"]), row.get("attribution")])
    for row in load(evidence / "after-evolution-insights.json"):
        lineage = row.get("lineage")
        if lineage:
            lineage = {key: lineage[key] for key in ("canonicalInsightId", "status")}
        put(f'evolution/insights/{row["insightId"]}', [row["currentRevisionId"], row["updatedAt"], row.get("attribution"), lineage])
        for revision in row["revisions"]:
            put(f'evolution/insight-revisions/{revision["revisionId"]}', row["insightId"])
    for row in load(evidence / "after-evolution-candidates.json"):
        put(f'evolution/candidates/{row["assetId"]}', [row["revisionId"], row.get("attribution")])
    for kind in ("processed", "pending"):
        for row in load(evidence / f"after-inbox-{kind}.json"):
            put(f'inbox/{row["itemId"]}', [int(row["availability"] == "available"),
                                         row["contentVersion"], row["sourceRevision"]])
    return versions


def validate_progress(value, backend):
    if value["format"] != FORMAT or value["backend"] != backend or value["task"] != TASK:
        raise ValueError("Cleanup progress does not match this task, format or Backend")


def finish(progress, batch, decisions):
    if digest(progress) != batch["parent"]:
        raise ValueError("Cleanup progress changed since begin")
    if not isinstance(decisions, dict) or set(decisions) != set(batch["items"]):
        raise ValueError("Supply a decision for each changed item")
    deferred = dict(progress.get("deferred", {}))
    for key, decision in decisions.items():
        if decision["status"] not in ("reviewed", "deferred") or not decision["reason"].strip():
            raise ValueError(f"Invalid or missing decision for {key}")
        deferred.pop(key, None)
        if decision["status"] == "deferred":
            deferred[key] = decision["reason"]
    return {**progress, "asOf": batch["asOf"], "versions": batch["versions"], "deferred": deferred}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("seed", "begin", "finish"))
    parser.add_argument("file", type=Path)
    parser.add_argument("--decisions", type=Path)
    args = parser.parse_args()
    root, backend, experience, evolution, records = stable_sources()
    home = root / "knowledge-cleanup" / TASK
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    checkpoint = home / "progress.json"
    repos = {row["repositoryId"]: row for row in records}
    if any(not re.fullmatch("[a-f0-9]{64}", repo) for repo in repos):
        raise ValueError("Invalid repository identity")
    if args.command == "seed":
        save(checkpoint, {"format": FORMAT, "backend": backend, "task": TASK, "asOf": moment(),
                          "versions": seed(args.file), "deferred": {}})
        return
    if args.command == "begin":
        progress = load(checkpoint)
        validate_progress(progress, backend)
        as_of = moment()
        versions, items = inventory(experience, evolution, Path.home() / ".runweave/knowledge-inbox/production/store.sqlite",
                                    repos, progress["versions"])
        batch = {"format": FORMAT, "backend": backend, "task": TASK, "parent": digest(progress),
                 "previousAsOf": progress["asOf"], "asOf": as_of, "versions": versions, "items": items}
        save(args.file, batch)
        counts = {}
        for key in items:
            source = key.split("/")[0]
            counts[source] = counts.get(source, 0) + 1
        print(encode({"batch": str(args.file), "changed": len(items), "bySource": counts,
                      "repositories": len(repos), "unavailableSources": sum(not repo.get("available") for repo in repos.values()),
                      "missingExperienceStores": sum(not (experience / repo / "store.sqlite").exists() for repo in repos),
                      "previouslyDeferred": len(progress["deferred"])}))
        return
    if not args.decisions:
        parser.error("finish requires --decisions")
    batch = load(args.file)
    validate_progress(batch, backend)
    with (home / "progress.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        progress = load(checkpoint)
        validate_progress(progress, backend)
        next_progress = finish(progress, batch, load(args.decisions))
        save(checkpoint, next_progress, replace=True)
    print(encode({"checkpoint": str(checkpoint), "decided": len(batch["items"]),
                  "deferred": len(next_progress["deferred"]), "asOf": batch["asOf"]}))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        sys.exit(f"Knowledge cleanup did not advance: {error}")
