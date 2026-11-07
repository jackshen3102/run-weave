"""Explicit local archive imports and day queries for ScreenJournal exports.

Only exported copies are read. The archive is separate from the recording writer's
store. No scheduler, network, Apple database access, or automatic deletion.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from usage_intervals import pair_events

DEFAULT_ARCHIVE = Path.home() / 'Library/Application Support/ScreenJournalAppUsage/archive.sqlite'
EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
SCHEMA_ID = 'screenjournal-app-usage-archive-v1'
SCHEMA = [
    'CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    '''CREATE TABLE imports(id TEXT PRIMARY KEY, captured_us INTEGER NOT NULL,
       imported_at TEXT NOT NULL, source_state TEXT NOT NULL, diagnostics TEXT NOT NULL)''',
    '''CREATE TABLE devices(device_id TEXT PRIMARY KEY, identity TEXT, identity_at INTEGER)''',
    '''CREATE TABLE events(device_id TEXT NOT NULL REFERENCES devices(device_id),
       timestamp_us INTEGER NOT NULL, app_id TEXT NOT NULL, gained INTEGER NOT NULL CHECK(gained IN (0,1)),
       first_import TEXT NOT NULL REFERENCES imports(id),
       PRIMARY KEY(device_id,timestamp_us,gained,app_id)) WITHOUT ROWID''',
]


def timestamp_us(value):
    # Early probe exports used dashes in the time portion of createdAt.
    value = re.sub(r'T(\d{2})-(\d{2})-(\d{2})Z$', r'T\1:\2:\3Z', value)
    date = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if date.tzinfo is None:
        raise ValueError('Timestamp must include its timezone')
    delta = date.astimezone(dt.timezone.utc) - EPOCH
    return delta.days * 86400000000 + delta.seconds * 1000000 + delta.microseconds


def iso(microseconds):
    return (EPOCH + dt.timedelta(microseconds=microseconds)).isoformat() if microseconds is not None else None


def safe_archive_path(path):
    path = Path(os.path.abspath(path.expanduser()))
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise ValueError('Archive path must not contain symlinks')
    recording = Path.home() / 'Library/Application Support/ScreenJournal'
    if path == recording or recording in path.parents:
        raise ValueError('Archive must be outside the recording writer store')
    for suffix in ('-wal', '-shm', '-journal'):
        if Path(str(path) + suffix).is_symlink():
            raise ValueError('Unsafe SQLite sidecar')
    return path


def check_schema(db):
    if db.execute('PRAGMA user_version').fetchone()[0] != 1:
        raise ValueError('Unsupported archive schema; no migration or reset performed')
    row = db.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()
    if not row or row[0] != SCHEMA_ID:
        raise ValueError('Not a ScreenJournal app usage archive')


def connect(path, writable):
    path = safe_archive_path(path)
    if writable:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Do not change permissions of an arbitrary existing parent directory.
        db = sqlite3.connect(path, timeout=10, isolation_level=None)
    else:
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=10, isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    try:
        db.execute('BEGIN IMMEDIATE' if writable else 'BEGIN')
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if writable and not tables and db.execute('PRAGMA user_version').fetchone()[0] == 0:
            for statement in SCHEMA:
                db.execute(statement)
            db.execute('INSERT INTO metadata VALUES (?,?)', ('schema', SCHEMA_ID))
            db.execute('PRAGMA user_version=1')
        check_schema(db)
        if writable:
            path.chmod(0o600)
        return db
    except Exception:
        db.close()
        raise


def import_snapshot(snapshot, archive):
    root = snapshot.resolve(strict=True)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('state') not in ('snapshot_collected', 'partial'):
        raise ValueError('Export did not collect records; existing archive is unchanged')
    # Always regenerate derived files from the exported SEGB bytes, never trust stale JSON.
    subprocess.run([sys.executable, str(Path(__file__).with_name('parse-snapshot.py')), str(root)],
                   check=True, stdout=subprocess.DEVNULL)
    summary = json.loads((root / 'summary.json').read_text())
    events = json.loads((root / 'parsed-events.json').read_text())
    captured = timestamp_us(manifest['createdAt'])
    fingerprint = {'manifest': manifest, 'files': [
        [s['device_id'], f['file'], f['sha256']] for s in summary for f in s['files']]}
    import_id = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
    diagnostics = {'devices': [{k: s[k] for k in ('device_id', 'counts', 'files', 'last')} for s in summary],
                   'deviceIdentityState': manifest.get('deviceIdentity', {}).get('state', 'unavailable'),
                   'completeness': 'unverified'}
    db = connect(archive, writable=True)
    try:
        prior = db.execute('SELECT 1 FROM imports WHERE id=?', (import_id,)).fetchone()
        added = 0
        if not prior:
            db.execute('INSERT INTO imports VALUES (?,?,?,?,?)',
                       (import_id, captured, dt.datetime.now(dt.timezone.utc).isoformat(), manifest['state'],
                        json.dumps(diagnostics, ensure_ascii=False)))
            for device in summary:
                db.execute('INSERT OR IGNORE INTO devices(device_id) VALUES (?)', (device['device_id'],))
                if device['identity']:
                    db.execute('''UPDATE devices SET identity=?, identity_at=? WHERE device_id=?
                                  AND (identity_at IS NULL OR identity_at<=?)''',
                               (json.dumps(device['identity'], ensure_ascii=False), captured, device['device_id'], captured))
            changes = db.total_changes
            db.executemany('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?)', [
                (event['device_id'], timestamp_us(event['timestamp']), event['app_id'],
                 int(event['gained_focus']), import_id) for event in events])
            added = db.total_changes - changes
        result = {'archive': str(archive), 'import_id': import_id, 'already_imported': bool(prior),
                  'added_events': added, 'total_events': db.execute('SELECT COUNT(*) FROM events').fetchone()[0],
                  'snapshot_count': db.execute('SELECT COUNT(*) FROM imports').fetchone()[0],
                  'source_state': manifest['state'], 'diagnostics': diagnostics}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def day_query(archive, day, timezone, device_id):
    date = dt.date.fromisoformat(day)
    zone = ZoneInfo(timezone)
    start = timestamp_us(dt.datetime.combine(date, dt.time.min, tzinfo=zone).isoformat())
    end = timestamp_us(dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min, tzinfo=zone).isoformat())
    db = connect(archive, writable=False)
    try:
        devices = db.execute('SELECT device_id, identity, identity_at FROM devices WHERE (? IS NULL OR device_id=?) ORDER BY device_id',
                             (device_id, device_id)).fetchall()
        if device_id and not devices:
            raise ValueError('Device ID is not present in this archive')
        results = []
        for device, identity, identity_at in devices:
            counts = collections.Counter()
            apps = {}
            # Stream the complete event history: late events repair prior intervals;
            # a session can start before this day or close in a later snapshot.
            cursor = db.execute('SELECT timestamp_us, app_id, gained FROM events WHERE device_id=? ORDER BY timestamp_us,gained,app_id', (device,))
            for app, a, b, quality in pair_events(cursor, counts):
                overlap = min(b, end) - max(a, start)
                if overlap <= 0:
                    continue
                row = apps.setdefault(app, {'app_id': app, 'seconds': 0.0, 'matched_seconds': 0.0,
                                           'inferred_seconds': 0.0, 'over_4h_seconds': 0.0, 'interval_count': 0})
                seconds = overlap / 1000000
                row['seconds'] += seconds
                row['matched_seconds' if quality == 'matched' else 'inferred_seconds'] += seconds
                if b - a > 14400000000:
                    row['over_4h_seconds'] += seconds
                row['interval_count'] += 1
            first, last = db.execute('SELECT MIN(timestamp_us), MAX(timestamp_us) FROM events WHERE device_id=?', (device,)).fetchone()
            results.append({'device_id': device, 'identity': json.loads(identity) if identity else None,
                            'identity_snapshot_at': iso(identity_at), 'first_event': iso(first), 'last_event': iso(last),
                            'bundle_id_count': len(apps), 'seconds': sum(row['seconds'] for row in apps.values()),
                            'apps': sorted(apps.values(), key=lambda row: (-row['seconds'], row['app_id'])),
                            'history_pairing_diagnostics': dict(counts)})
        snapshots, latest = db.execute('SELECT COUNT(*), MAX(captured_us) FROM imports').fetchone()
        diagnostics = [json.loads(row[0]) for row in db.execute('SELECT diagnostics FROM imports ORDER BY captured_us DESC, id DESC LIMIT 1')]
        return {'date': day, 'timezone': timezone, 'coverage': 'observed_only', 'snapshot_count': snapshots,
                'latest_snapshot_at': iso(latest), 'latest_import_diagnostics': diagnostics,
                'devices': results, 'notes': ['Counts include system UI bundle IDs, not installed-app counts.',
                    'No events or no completed interval does not prove zero use.',
                    'Foreground focus durations are not official Screen Time totals; sync and identity can be stale.',
                    'Events absent from later snapshots are retained, not treated as deletion instructions.']}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    commands = parser.add_subparsers(dest='command', required=True)
    load = commands.add_parser('import', help='Incrementally import an exported snapshot')
    load.add_argument('snapshot', type=Path)
    query = commands.add_parser('day', help='Read per-device, per-app durations for one day')
    query.add_argument('date')
    query.add_argument('--timezone', default='Asia/Shanghai')
    query.add_argument('--device', help='Exact exported device directory ID; no name guessing')
    options = parser.parse_args()
    os.umask(0o077)
    try:
        archive = safe_archive_path(options.archive)
        result = (import_snapshot(options.snapshot, archive) if options.command == 'import'
                  else day_query(archive, options.date, options.timezone, options.device))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, ZoneInfoNotFoundError, sqlite3.Error, subprocess.CalledProcessError) as error:
        parser.exit(1, 'App usage archive: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
