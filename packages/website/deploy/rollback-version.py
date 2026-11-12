#!/usr/bin/env python3
"""Verify a retained production release; change current only with --apply."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('release', help='retained release directory name')
parser.add_argument('--apply', action='store_true', help='atomically change the production release')
args = parser.parse_args()
if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]+', args.release):
    parser.error('invalid release name')
base = Path('/var/www/runweave-website')
release = base / 'releases' / args.release
manifest = json.loads((base / 'deployments' / args.release / 'manifest.json').read_text())
if manifest.get('release') != args.release or manifest.get('site') != 'https://runweave.jackshen310.cn':
    raise SystemExit('Refusing a release built for another site or release ID')
if release.is_symlink() or not release.is_dir():
    raise SystemExit('Expected a retained release directory')
files = {}
for path in release.rglob('*'):
    if path.is_symlink():
        raise SystemExit('Unexpected symlink in release')
    if path.is_file():
        files[str(path.relative_to(release))] = hashlib.sha256(path.read_bytes()).hexdigest()
if files != manifest['files'] or 'index.html' not in files:
    raise SystemExit('Release files do not match the deployment manifest')
current = base / 'current'
if not current.is_symlink():
    raise SystemExit('Expected current to be a release symlink')
previous = str(current.resolve(strict=True))
if args.apply and previous != str(release):
    # The temporary symlink lives on the same filesystem as current.
    with tempfile.TemporaryDirectory(prefix='.rollback-', dir=str(base)) as temporary:
        pointer = Path(temporary) / 'current'
        os.symlink(str(release), pointer)
        os.replace(pointer, current)
print(json.dumps({'release': args.release, 'filesVerified': len(files),
                  'mode': 'apply' if args.apply else 'check', 'previous': previous,
                  'current': str(current.resolve(strict=True))}))
