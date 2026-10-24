#!/usr/bin/env python3
"""Issue scoped Runweave preview links for HTML galleries or MP4 videos."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import urllib.parse
sys.dont_write_bytecode = True
from common import base_url, http, write_json


def configure_parser(parser, default_kind='auto'):
    parser.add_argument('--file', '--video', dest='file', type=Path, required=True,
                        help='Local HTML or MP4; --video is a legacy alias')
    parser.add_argument('--kind', choices=['auto', 'html', 'video'], default=default_kind)
    parser.add_argument('--project-id', required=True)
    parser.add_argument('--viewer-base-url', required=True)
    parser.add_argument('--profile', default='local')
    parser.add_argument('--settings', type=Path, default=Path.home() / '.runweave/settings.yaml')
    parser.add_argument('--token-env', help='Name of an existing API-token environment variable')
    parser.add_argument('--backend', help='Configured Backend URL; required with --token-env')
    parser.add_argument('--output', type=Path, required=True)


def preview(args):
    file = args.file.resolve(strict=True)
    if not file.is_file():
        raise ValueError('Preview input must be a regular file')
    kind = args.kind
    if kind == 'auto':
        kind = 'html' if file.suffix.lower() in ('.html', '.htm') else 'video'
    if ((kind == 'html' and file.suffix.lower() not in ('.html', '.htm')) or
            (kind == 'video' and file.suffix.lower() != '.mp4')):
        raise ValueError('Expected HTML or MP4 input matching preview kind')
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError('Use a new output path for each preview ticket')
    if not args.output.parent.is_dir():
        raise ValueError('Preview output parent must already exist')
    if args.token_env:
        if not args.backend:
            raise ValueError('--token-env requires --backend')
        token = os.environ[args.token_env]
        local = base_url(args.backend)
    else:
        if args.settings.stat().st_mode & 0o077:
            raise ValueError('Connection settings must be private (0600)')
        try:
            import yaml
        except ImportError as error:
            raise ValueError('Profile preview requires PyYAML; use --token-env with --backend otherwise') from error
        config = yaml.safe_load(args.settings.read_text())['cli']['profiles'][args.profile]
        token = config['accessToken']
        local = base_url(config['baseUrl'])
    viewer = base_url(args.viewer_base_url)
    identity = json.loads(http(local + '/health')[2]).get('serviceInstanceId')
    if not identity or json.loads(http(viewer + '/health')[2]).get('serviceInstanceId') != identity:
        raise ValueError('Viewer and configured Backend service identities differ')
    payload = json.dumps({'path': str(file)}).encode()
    _, _, body = http(local + '/api/terminal/project/' + urllib.parse.quote(args.project_id, safe='') +
                      '/preview/' + kind + '-ticket', {'Authorization': 'Bearer ' + token,
                      'Content-Type': 'application/json'}, payload, 'POST')
    ticket = json.loads(body)
    path = ticket['path']
    if not path.startswith('/' + kind + '-preview/') or urllib.parse.urlsplit(path).netloc:
        raise ValueError('Unexpected preview-ticket path')
    url = viewer + path
    status, headers, _ = http(url, method='HEAD')
    mime = 'text/html' if kind == 'html' else 'video/mp4'
    if (status != 200 or headers.get('Content-Type', '').split(';')[0] != mime or
            int(headers.get('Content-Length', '-1')) != file.stat().st_size):
        raise ValueError('Anonymous preview HEAD does not match local input')
    now = datetime.now(timezone.utc)
    expires = int(ticket['expiresIn'])
    receipt = {'url': url, 'file': str(file), 'kind': kind, 'backendServiceInstanceId': identity,
               'viewerBaseUrl': viewer, 'issuedAt': now.isoformat(), 'expiresIn': expires,
               'expiresAt': (now + timedelta(seconds=expires)).isoformat(), 'headStatus': 200,
               'physicalPhoneReachability': 'not-verified',
               'hostPrerequisites': ['Mac awake', 'Backend running', 'viewer route reachable', 'ticket valid']}
    if kind == 'video':
        status, headers, content = http(url, headers={'Range': 'bytes=0-1023'})
        with file.open('rb') as f:
            expected = f.read(1024)
        if status != 206 or content != expected or headers.get('Accept-Ranges') != 'bytes':
            raise ValueError('Anonymous Range request did not match local bytes')
        receipt.update(video=str(file), rangeStatus=206, rangeMatchesLocal=True)
    else:
        status, _, content = http(url)
        if status != 200 or content != file.read_bytes():
            raise ValueError('Anonymous HTML GET did not match local bytes')
        receipt.update(htmlStatus=200, htmlMatchesLocal=True,
                       resources='not-verified; check styles/scripts/images in a real browser')
    write_json(args.output, receipt, private=True)
    print(json.dumps({k: v for k, v in receipt.items() if k != 'url'}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    configure_parser(parser)
    preview(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error), 'automaticRetry': False}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
