"""Shared local media and preview helpers; no optional dependencies at import time."""
import hashlib
import json
import math
import os
import subprocess
import urllib.parse
import urllib.request

def write_json(path, value, private=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o666)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')

def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout

def probe(path):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_streams',
                           '-show_format', '-of', 'json', str(path)]))

def duration(info):
    value = float(info['format']['duration'])
    if not math.isfinite(value) or value <= 0:
        raise ValueError('Video duration must be finite and positive')
    if not any(s['codec_type'] == 'video' for s in info['streams']):
        raise ValueError('No video stream')
    return value

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def number(value, low, high, label):
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or
            not math.isfinite(value) or not low <= value <= high):
        raise ValueError(f'{label} must be a finite number in [{low}, {high}]')
    return value

def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{label} must be nonempty text')
    return value

def http(url, headers=None, body=None, method=None):
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    # Never forward an API token or preview capability through redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        return response.status, response.headers, response.read()

def base_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or
            parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Expected HTTP(S) base URL without credentials/query/fragment')
    return value.rstrip('/')
