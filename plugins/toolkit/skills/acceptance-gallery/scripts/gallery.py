#!/usr/bin/env python3
"""Build portable, local evidence galleries. Python 3.9+; no third-party packages."""
import argparse
import copy
import hashlib
import html
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import sys
import tempfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

TEMPLATE_VERSION = '1.0.0'
TEMPLATES = Path(__file__).resolve().parent.parent / 'templates'
ID = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$')
MAX_FILE = 32 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024


class Invalid(ValueError):
    pass


def require(ok, where, message):
    if not ok:
        raise Invalid(f'{where}: {message}')


def fields(value, where, required, optional=()):
    require(isinstance(value, dict), where, '需要对象')
    missing = set(required) - value.keys()
    unknown = value.keys() - set(required) - set(optional)
    require(not missing, where, f'缺少字段 {sorted(missing)}')
    require(not unknown, where, f'未知字段 {sorted(unknown)}')


def string(value, where, nullable=False):
    if value is None and nullable:
        return
    require(isinstance(value, str) and bool(value.strip()), where, '需要非空字符串')


def strings(value, where):
    require(isinstance(value, list), where, '需要字符串数组')
    for i, item in enumerate(value):
        string(item, f'{where}[{i}]')


def identifier(value, where):
    require(isinstance(value, str) and ID.fullmatch(value), where, 'ID 仅支持字母、数字、-、_，长度 1–80')


def local_file(root, relative):
    string(relative, 'path')
    parts = PurePosixPath(relative).parts
    require(not relative.startswith('/') and '\\' not in relative and ':' not in relative
            and '..' not in parts, relative, '需要根目录内的相对路径')
    target = (root / relative).resolve(strict=True)
    require(target.is_relative_to(root) and target.is_file(), relative, '文件不存在或超出素材目录')
    return target


def read_file(path, limit):
    require(path.stat().st_size <= limit, path.name, f'超过 {limit} 字节限制')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, path.name, '读取时文件超过大小限制')
    return data


def image_info(data, suffix, where):
    """Check container structure and dimensions; browser acceptance verifies decoding."""
    if suffix == '.png':
        require(data.startswith(b'\x89PNG\r\n\x1a\n'), where, '不是 PNG')
        pos, size, has_data, ended = 8, None, False, False
        while pos + 12 <= len(data):
            length = struct.unpack('>I', data[pos:pos + 4])[0]
            chunk = data[pos + 4:pos + 8]
            end = pos + 8 + length
            require(end + 4 <= len(data), where, 'PNG chunk 被截断')
            require(zlib.crc32(data[pos + 4:end]) & 0xffffffff == struct.unpack('>I', data[end:end + 4])[0], where, 'PNG CRC 错误')
            if pos == 8:
                require(chunk == b'IHDR' and length == 13, where, '缺少 PNG IHDR')
                size = struct.unpack('>II', data[pos + 8:pos + 16])
            has_data |= chunk == b'IDAT'
            pos = end + 4
            if chunk == b'IEND':
                require(length == 0 and pos == len(data), where, 'PNG 结束块不合法')
                ended = True
                break
        require(ended and has_data, where, 'PNG 缺少数据或结束块')
    else:
        require(data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9'), where, '不是完整 JPEG')
        pos, size = 2, None
        while pos < len(data) - 2:
            require(data[pos] == 255, where, 'JPEG marker 不合法')
            while pos < len(data) and data[pos] == 255:
                pos += 1
            require(pos < len(data), where, 'JPEG 被截断')
            marker = data[pos]
            pos += 1
            if marker in (0xda, 0xd9):
                break
            if marker == 1 or 0xd0 <= marker <= 0xd7:
                continue
            require(pos + 2 <= len(data), where, 'JPEG 被截断')
            length = struct.unpack('>H', data[pos:pos + 2])[0]
            require(length >= 2 and pos + length <= len(data), where, 'JPEG segment 被截断')
            if marker in (0xc0, 0xc1, 0xc2):
                require(length >= 8, where, 'JPEG SOF 不合法')
                height, width = struct.unpack('>HH', data[pos + 3:pos + 7])
                size = (width, height)
            pos += length
        require(size is not None, where, '不支持的 JPEG 编码或缺少尺寸')
    require(size and all(0 < n <= 32768 for n in size), where, '图片尺寸不合法或超出 32768px')
    return dict(width=size[0], height=size[1])


def parse_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, key, '重复 JSON 字段')
            result[key] = value
        return result
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(Invalid(f'非法 JSON 数字 {value}')))


def load_task(root, input_name):
    raw = read_file(local_file(root, input_name), MAX_TEXT)
    task = parse_json(raw)
    fields(task, 'root', ['schemaVersion', 'task', 'assets', 'pages'])
    require(type(task['schemaVersion']) is int and task['schemaVersion'] == 1, 'schemaVersion', '仅支持版本 1')
    meta = task['task']
    fields(meta, 'task', ['id', 'title', 'scope', 'materialKind', 'limitations'])
    identifier(meta['id'], 'task.id')
    for key in ('title', 'scope'):
        string(meta[key], f'task.{key}')
    require(meta['materialKind'] in ('current', 'historical'), 'task.materialKind', '需要 current/historical')
    strings(meta['limitations'], 'task.limitations')
    require(isinstance(task['assets'], list), 'assets', '需要数组')
    assets, payloads, image_sizes = {}, {}, {}
    for i, asset in enumerate(task['assets']):
        where = f'assets[{i}]'
        fields(asset, where, ['id', 'kind', 'path', 'label', 'origin'])
        identifier(asset['id'], where + '.id')
        require(asset['id'] not in assets, where, '重复素材 ID')
        require(asset['kind'] in ('image', 'text'), where, 'kind 需要 image/text')
        string(asset['label'], where + '.label')
        fields(asset['origin'], where + '.origin', ['surface', 'capturedAt', 'sourceRef'])
        for key, value in asset['origin'].items():
            string(value, where + '.origin.' + key, nullable=True)
        source = local_file(root, asset['path'])
        suffix = source.suffix.lower()
        data = read_file(source, MAX_FILE if asset['kind'] == 'image' else MAX_TEXT)
        if asset['kind'] == 'image':
            require(suffix in ('.png', '.jpg', '.jpeg'), where, '图片仅支持 PNG/JPEG')
            image_sizes[asset['id']] = image_info(data, suffix, where)
        else:
            require(suffix in ('.txt', '.md', '.json'), where, '文字仅支持 TXT/MD/JSON')
            data.decode('utf-8')
            if suffix == '.json':
                parse_json(data)
        assets[asset['id']] = asset
        payloads[asset['id']] = (data, suffix)
    require(isinstance(task['pages'], list) and len(task['pages']) > 0, 'pages', '至少需要一页')
    seen = set()
    for i, page in enumerate(task['pages']):
        where = f'pages[{i}]'
        fields(page, where, ['id', 'type', 'title', 'description', 'evidenceState', 'items', 'sourceIds'], ['lookAt', 'limitations'])
        identifier(page['id'], where + '.id')
        require(page['id'] not in seen, where, '重复页 ID')
        seen.add(page['id'])
        for key in ('title', 'description', 'lookAt'):
            if key in page:
                string(page[key], where + '.' + key)
        strings(page.get('limitations', []), where + '.limitations')
        require(page['evidenceState'] in ('observed', 'insufficient', 'not-run'), where, '未知 evidenceState')
        require(isinstance(page['type'], str) and page['type'] in ('single', 'compare', 'sequence', 'text'), where, '未知页型')
        items = page['items']
        require(isinstance(items, list), where, 'items 需要数组')
        low, high = {'single': (1, 1), 'compare': (2, 2), 'sequence': (2, 4), 'text': (1, 1)}[page['type']]
        require(low <= len(items) <= high, where, f'当前页型需要 {low}–{high} 个素材项')
        for j, item in enumerate(items):
            iw = where + f'.items[{j}]'
            fields(item, iw, ['assetId', 'label'], ['alt', 'crop'])
            string(item['assetId'], iw + '.assetId')
            string(item['label'], iw + '.label')
            require(item['assetId'] in assets, iw, '素材 ID 不存在')
            asset = assets[item['assetId']]
            kind = 'text' if page['type'] == 'text' else 'image'
            require(asset['kind'] == kind, iw, '素材类型与页型不匹配')
            if kind == 'image':
                string(item.get('alt'), iw + '.alt')
            else:
                require('crop' not in item and 'alt' not in item, iw, '文字项不接受 crop/alt')
            if 'crop' in item:
                crop = item['crop']
                fields(crop, iw + '.crop', ['x', 'y', 'width', 'height'])
                require(all(type(v) is int for v in crop.values()), iw, '取景参数必须为整数')
                size = image_sizes[item['assetId']]
                require(crop['x'] >= 0 and crop['y'] >= 0 and crop['width'] > 0 and crop['height'] > 0
                        and crop['x'] + crop['width'] <= size['width']
                        and crop['y'] + crop['height'] <= size['height'], iw, '取景超出原图或尺寸不合法')
                require(payloads[item['assetId']][1] == '.png', iw, 'JPEG 取景请先重新采集 PNG；避免 EXIF 方向歧义')
        strings(page['sourceIds'], where + '.sourceIds')
        for source_id in page['sourceIds']:
            require(source_id in assets and assets[source_id]['kind'] == 'text', where, 'sourceIds 只能引用存在的文字素材')
    return task, payloads, image_sizes, hashlib.sha256(raw).hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def build(loaded, output):
    task, payloads, sizes, input_hash = loaded
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Serializes concurrent builds of the same target without replacing old evidence.
    lock = output.parent / ('.' + output.name + '.gallery-lock')
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    stage = None
    try:
        require(not output.exists() and not output.is_symlink(), 'output', '目标已存在，请使用新目录')
        stage = Path(tempfile.mkdtemp(prefix='.gallery-', dir=output.parent))
        (stage / 'assets').mkdir()
        snapshot = copy.deepcopy(task)
        display = copy.deepcopy(task)
        manifest = {'schemaVersion': 1, 'templateVersion': TEMPLATE_VERSION,
                    'inputSha256': input_hash, 'assets': []}
        for index, asset in enumerate(snapshot['assets']):
            data, suffix = payloads[asset['id']]
            # Numeric prefixes also keep distinct IDs safe on case-insensitive disks.
            relative = f'assets/{index + 1:04d}-{asset["id"]}{suffix}'
            (stage / relative).write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            asset['path'] = relative
            shown = display['assets'][index]
            shown['path'] = relative
            shown.update(sizes.get(asset['id'], {}))
            if asset['kind'] == 'text':
                shown['text'] = data.decode('utf-8')
            manifest['assets'].append({'id': asset['id'], 'path': relative, 'sha256': digest})
        display['templateVersion'] = TEMPLATE_VERSION
        embedded = json.dumps(display, ensure_ascii=False).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
        template = (TEMPLATES / 'reader.html').read_text(encoding='utf-8')
        # Split once so placeholders in user-supplied titles cannot be interpreted.
        before, after = template.split('@@DATA@@')
        before = before.replace('@@TITLE@@', html.escape(task['task']['title']))
        (stage / 'index.html').write_text(before + embedded + after, encoding='utf-8')
        for name in ('reader.css', 'reader.js'):
            shutil.copyfile(TEMPLATES / name, stage / name)
        dump(stage / 'task.json', snapshot)
        dump(stage / 'manifest.json', manifest)
        require(not output.exists() and not output.is_symlink(), 'output', '目标已存在')
        stage.rename(output)
        stage = None
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        lock.unlink()
    return {'output': str(output), 'index': str(output / 'index.html'), 'pages': len(task['pages'])}


def serve(directory, port):
    root = directory.resolve(strict=True)
    manifest = parse_json(read_file(root / 'manifest.json', MAX_TEXT))
    require(manifest.get('schemaVersion') == 1 and isinstance(manifest.get('assets'), list), 'directory', '不是生成的成果目录')
    allowed = {'index.html', 'reader.css', 'reader.js', 'task.json', 'manifest.json'}
    allowed.update(asset['path'] for asset in manifest['assets'])
    for relative in allowed:
        local_file(root, relative)
    mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8'}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_file(False)

        def do_HEAD(self):
            self.send_file(True)

        def send_file(self, head):
            relative = unquote(urlsplit(self.path).path).removeprefix('/') or 'index.html'
            try:
                require(relative in allowed, relative, '不在成果清单内')
                target = local_file(root, relative)
                data = read_file(target, MAX_FILE * 8)
            except (Invalid, OSError, ValueError):
                self.send_error(404, 'Not found')
                return
            self.send_response(200)
            self.send_header('Content-Type', mime.get(target.suffix.lower(), 'text/plain; charset=utf-8'))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            if not head:
                self.wfile.write(data)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', port), Handler) as server:
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}/', 'pid': os.getpid(),
                          'directory': str(root), 'stop': '前台按 Ctrl-C；后台停止前核对 PID 与完整命令'}, ensure_ascii=False), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def main():
    parser = argparse.ArgumentParser(description='本地图文验收阅读器：validate / build / serve')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('validate', 'build'):
        command = sub.add_parser(name)
        command.add_argument('--input-root', type=Path, required=True)
        command.add_argument('--input', default='task.json')
        if name == 'build':
            command.add_argument('--output', type=Path, required=True)
    command = sub.add_parser('serve')
    command.add_argument('--directory', type=Path, required=True)
    command.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    try:
        if args.command == 'serve':
            require(0 <= args.port <= 65535, 'port', '端口范围 0–65535')
            serve(args.directory, args.port)
            return
        loaded = load_task(args.input_root.resolve(strict=True), args.input)
        result = build(loaded, args.output) if args.command == 'build' else {'valid': True, 'pages': len(loaded[0]['pages']), 'assets': len(loaded[0]['assets'])}
        print(json.dumps(result, ensure_ascii=False))
    except (Invalid, OSError, ValueError, KeyError, TypeError) as error:
        print(f'gallery: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
