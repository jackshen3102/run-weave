"""Local checks for generated galleries; no credentials, network or HTML crawling."""
import json
from pathlib import Path
import re
import stat

# Keep the delivery limits aligned with backend/src/terminal/preview/html-preview.ts.
MAX_HTML_BYTES = 1024 * 1024
MAX_RESOURCE_BYTES = 5 * 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_TEMPLATE_VERSIONS = ('1.0.0', '1.1.0', '1.2.0')
_SHA256 = re.compile(r'[0-9a-fA-F]{64}')


def check_gallery(directory: Path) -> dict:
    """Check only fixed files and explicit manifest assets, counting unique paths.

    ready means these local files meet delivery limits, not that a browser loaded
    their contents or a phone can reach the Backend. Empty asset lists are valid.
    """
    result = {'target': 'runweave-html', 'ready': False, 'filesChecked': 0, 'issues': []}

    def issue(path, reason, **details):
        result['issues'].append({'path': path, 'reason': reason, **details})

    try:
        root = directory.resolve(strict=True)
        if not root.is_dir():
            raise ValueError('Gallery root must be a directory')
    except (OSError, RuntimeError, ValueError) as error:
        issue(str(directory), str(error))
        return result

    checked = {}

    def inspect(relative, limit):
        if relative in checked:
            return checked[relative]
        checked[relative] = None
        result['filesChecked'] += 1
        if (not relative or '\\' in relative or '\x00' in relative or
                any(part in ('', '.', '..') for part in relative.split('/'))):
            issue(relative, 'Invalid relative file path; directory escapes are not allowed')
            return None
        try:
            resolved = (root / relative).resolve(strict=True)
            if not resolved.is_relative_to(root):
                issue(relative, 'File or symlink escapes the gallery directory')
                return None
            info = resolved.stat()
            if not stat.S_ISREG(info.st_mode):
                issue(relative, 'Expected a regular file')
                return None
            if info.st_size > limit:
                issue(relative, 'File exceeds local delivery size limit',
                      bytes=info.st_size, limitBytes=limit)
                return None
        except (OSError, RuntimeError, ValueError) as error:
            issue(relative, 'Missing or inaccessible file: ' + str(error))
            return None
        checked[relative] = resolved
        return resolved

    for name in ('index.html', 'reader.css', 'reader.js', 'task.json', 'manifest.json'):
        limit = (MAX_HTML_BYTES if name == 'index.html' else
                 MAX_MANIFEST_BYTES if name == 'manifest.json' else MAX_RESOURCE_BYTES)
        inspect(name, limit)
    manifest_path = checked['manifest.json']
    if manifest_path is None:
        return result

    def unique_object(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError('Duplicate JSON key: ' + key)
            obj[key] = value
        return obj

    def reject_constant(value):
        raise ValueError('Invalid JSON constant: ' + value)

    try:
        # Bound the read as well as the stat, even if the file changed meanwhile.
        with manifest_path.open('rb') as stream:
            data = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(data) > MAX_MANIFEST_BYTES:
            issue('manifest.json', 'Manifest exceeds local parsing limit',
                  bytes=len(data), limitBytes=MAX_MANIFEST_BYTES)
            return result
        manifest = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object,
                              parse_constant=reject_constant)
    except (OSError, ValueError, RecursionError) as error:
        issue('manifest.json', 'Invalid or unreadable manifest JSON: ' + str(error))
        return result
    if not isinstance(manifest, dict):
        issue('manifest.json', 'Manifest must be an object')
        return result
    if type(manifest.get('schemaVersion')) is not int or manifest['schemaVersion'] != 1:
        issue('manifest.json', 'Expected manifest schemaVersion 1')
    version = manifest.get('templateVersion')
    if version not in _TEMPLATE_VERSIONS:
        issue('manifest.json', 'Unsupported or missing templateVersion')
    if version in ('1.1.0', '1.2.0'):
        inspect('viewer.css', MAX_RESOURCE_BYTES)
    if version == '1.2.0':
        inspect('report.css', MAX_RESOURCE_BYTES)
    if not isinstance(manifest.get('inputSha256'), str) or not _SHA256.fullmatch(manifest['inputSha256']):
        issue('manifest.json', 'inputSha256 must be a SHA-256 hex string')
    assets = manifest.get('assets')
    if not isinstance(assets, list):
        issue('manifest.json', 'assets must be an array (it may be empty)')
        return result
    ids, paths = set(), set()
    for index, asset in enumerate(assets):
        location = f'manifest.json assets[{index}]'
        if not isinstance(asset, dict):
            issue('manifest.json', location + ' must be an object')
            continue
        asset_id = asset.get('id')
        if not isinstance(asset_id, str) or not asset_id.strip():
            issue('manifest.json', location + '.id must be a nonempty string')
        elif asset_id in ids:
            issue('manifest.json', location + '.id is duplicated')
        else:
            ids.add(asset_id)
        if not isinstance(asset.get('sha256'), str) or not _SHA256.fullmatch(asset['sha256']):
            issue('manifest.json', location + '.sha256 must be a SHA-256 hex string')
        relative = asset.get('path')
        if not isinstance(relative, str) or not relative:
            issue('manifest.json', location + '.path must be a nonempty relative path')
            continue
        if relative in paths:
            issue(relative, 'Duplicate manifest asset path')
        paths.add(relative)
        inspect(relative, MAX_RESOURCE_BYTES)
    result['ready'] = not result['issues']
    return result


def require_ready(result: dict) -> None:
    """Stop delivery on failed local checks and identify the affected files."""
    if result.get('ready') is True:
        return
    details = []
    for item in result.get('issues', []):
        description = f'{item["path"]}: {item["reason"]}'
        if 'bytes' in item and 'limitBytes' in item:
            description += f' ({item["bytes"]} bytes; limit {item["limitBytes"]} bytes)'
        details.append(description)
    raise ValueError('Runweave HTML local preflight failed: ' + ('; '.join(details) or 'not ready'))
