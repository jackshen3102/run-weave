#!/usr/bin/env python3
"""OpenScreen rendering and scoped Runweave preview; Python 3.9+."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import queue
import shutil
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
from common import digest, duration, number, probe, run, text, write_json
from preview import configure_parser, preview

DEFAULT_APP = '/Applications/Openscreen.app/Contents/MacOS/Openscreen'
REQUIRED = {'createProject', 'getCurrentDocument', 'createCheckpoint',
            'setEditorSettings', 'addZooms', 'addAnnotation', 'exportVideo'}
ZOOM_LEVELS = (1.25, 1.5, 1.8, 2.2, 3.5, 5)


def load_recipe(path):
    path = path.resolve(strict=True)
    data = json.loads(path.read_text())
    if data.get('schemaVersion') != 1:
        raise ValueError('Expected recipe schemaVersion 1')
    text(data.get('title'), 'title')
    source = data.get('source', {})
    for key in ('surface', 'description', 'captureMethod'):
        text(source.get(key), 'source.' + key)
    video = (path.parent / text(data.get('video'), 'video')).resolve(strict=True)
    if not video.is_file():
        raise ValueError('video must be a file')
    total = duration(probe(video))
    for kind in ('callouts', 'zooms'):
        regions = data.get(kind, [])
        if not isinstance(regions, list):
            raise ValueError(kind + ' must be an array')
        previous = 0
        for region in regions:
            start = number(region.get('start'), 0, total, kind + '.start')
            end = number(region.get('end'), 0, total, kind + '.end')
            if end <= start or start < previous:
                raise ValueError(kind + ' must be ordered, nonoverlapping, positive spans')
            previous = end
            if kind == 'callouts':
                text(region.get('text'), 'callout.text')
            else:
                number(region.get('scale'), 1, 5, 'zoom.scale')
                if region['scale'] not in ZOOM_LEVELS:
                    raise ValueError('zoom.scale must be one of ' + str(ZOOM_LEVELS))
                for key in ('x', 'y'):
                    number(region.get('focus', {}).get(key), 0, 1, 'zoom.focus.' + key)
    style = data.get('captionStyle', {})
    for key, default, low, high in [('fontSize', 64, 8, 200), ('x', 50, 0, 100), ('y', 74, 0, 100)]:
        number(style.get(key, default), low, high, 'captionStyle.' + key)
    samples = data.get('sampleTimes')
    if samples is None:
        samples = sorted(set(round((r['start'] + r['end']) / 2, 3)
                             for k in ('callouts', 'zooms') for r in data.get(k, []))) or [total / 2]
    if not isinstance(samples, list) or not samples:
        raise ValueError('sampleTimes must be a nonempty array')
    for sample in samples:
        number(sample, 0, max(0, total - 0.05), 'sample time')
    return data, video, total, samples


class Mcp:
    def __init__(self, executable, directory):
        self.directory = directory
        self.sequence = 0
        self.answers = queue.Queue()
        self.stderr = (directory / 'openscreen-stderr.log').open('xb')
        env = os.environ.copy()
        env.pop('ELECTRON_RUN_AS_NODE', None)
        self.proc = subprocess.Popen([executable, 'mcp'], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=self.stderr, env=env)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                value = json.loads(line)
                if isinstance(value, dict) and 'id' in value:
                    self.answers.put(value)
            except (ValueError, UnicodeDecodeError):
                continue
        self.answers.put(None)

    def rpc(self, method, params=None, notify=False):
        self.sequence += 1
        message = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            message['params'] = params
        if not notify:
            message['id'] = self.sequence
        self.proc.stdin.write((json.dumps(message) + '\n').encode())
        self.proc.stdin.flush()
        if notify:
            return None
        try:
            answer = self.answers.get(timeout=240)
        except queue.Empty as error:
            raise RuntimeError('MCP response timed out; result unknown, no automatic retry') from error
        if not answer or answer.get('id') != self.sequence:
            raise RuntimeError('MCP ended or response id mismatched; no automatic retry')
        if 'error' in answer:
            raise RuntimeError(str(answer['error']))
        return answer['result']

    def initialize(self):
        server = self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                          'clientInfo': {'name': 'acceptance', 'version': '1'}})
        self.rpc('notifications/initialized', notify=True)
        tools = self.rpc('tools/list')
        missing = REQUIRED - {t['name'] for t in tools['tools']}
        if missing:
            raise RuntimeError('Missing MCP tools: ' + ', '.join(sorted(missing)))
        write_json(self.directory / 'openscreen-server.json', server)
        write_json(self.directory / 'openscreen-tools.json', tools)
        return server

    def call(self, name, arguments):
        started = time.monotonic()
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        with (self.directory / 'mcp-calls.jsonl').open('a') as f:
            f.write(json.dumps({'tool': name, 'arguments': arguments,
                               'seconds': round(time.monotonic() - started, 3), 'result': result}) + '\n')
        if result.get('isError'):
            raise RuntimeError(f'{name}: ' + ' '.join(b.get('text', '') for b in result.get('content', [])))
        for block in result.get('content', []):
            if block.get('type') == 'text':
                try:
                    return json.loads(block['text'])
                except ValueError:
                    continue
        return result

    def close(self):
        # Only this child, never the GUI app or another MCP process.
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, BrokenPipeError):
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        finally:
            self.stderr.close()


def app_version(executable):
    info = Path(executable).parent.parent / 'Info.plist'
    if info.is_file():
        with info.open('rb') as f:
            return plistlib.load(f).get('CFBundleShortVersionString')
    return None


def dependencies(executable):
    for command in ('ffmpeg', 'ffprobe'):
        if not shutil.which(command):
            raise ValueError(command + ' is missing')
    if not Path(executable).is_file() or not os.access(executable, os.X_OK):
        raise ValueError('OpenScreen executable is missing: ' + executable)


def build(args):
    dependencies(args.openscreen)
    recipe, video, total, samples = load_recipe(args.input)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    manifest = {'status': 'started', 'source': recipe['source'], 'sourceVideo': str(video),
                'sourceSha256': digest(video), 'sourceDurationSeconds': total,
                'sourceFrameRateNote': 'Output FPS does not prove capture frequency or animation smoothness.',
                'openscreenVersion': app_version(args.openscreen), 'productAcceptance': 'not-determined-by-renderer',
                'browserPlayback': 'not-run', 'physicalPhone': 'not-run', 'preview': 'not-issued'}
    client = None
    started = time.monotonic()
    try:
        write_json(out / 'recipe.json', recipe)
        client = Mcp(args.openscreen, out)
        client.initialize()
        project = client.call('createProject', {'title': recipe['title'], 'videoPath': str(video)})
        project_id = project['projectId']
        manifest['projectId'] = project_id
        client.call('getCurrentDocument', {'projectId': project_id})
        manifest['checkpoint'] = client.call('createCheckpoint', {'projectId': project_id})
        client.call('setEditorSettings', {'projectId': project_id, 'wallpaper': '#101827', 'padding': 7,
                    'borderRadius': 12, 'shadowIntensity': 0.15, 'motionBlurAmount': 0,
                    'depthOfField': False, 'cursor': {'show': False}, 'aspectRatio': 'auto'})
        if recipe.get('zooms'):
            client.call('addZooms', {'projectId': project_id, 'regions': [
                {'startSec': z['start'], 'endSec': z['end'], 'depth': ZOOM_LEVELS.index(z['scale']) + 1,
                 'focus': {'cx': z['focus']['x'], 'cy': z['focus']['y']}, 'focusMode': 'manual'}
                for z in recipe['zooms']]})
        style = recipe.get('captionStyle', {})
        for caption in recipe.get('callouts', []):
            client.call('addAnnotation', {'projectId': project_id, 'startSec': caption['start'],
                        'endSec': caption['end'], 'type': 'text', 'text': caption['text'],
                        'x': style.get('x', 50), 'y': style.get('y', 74), 'fontSize': style.get('fontSize', 64),
                        'color': '#ffffff', 'background': '#101827', 'bold': True, 'animation': 'none'})
        document = client.call('getCurrentDocument', {'projectId': project_id})
        write_json(out / 'editor-document.json', document)
        client.call('exportVideo', {'projectId': project_id, 'path': str(out / 'review-master.mp4'),
                                   'quality': 'medium', 'fps': 30})
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-n', '-i', str(out / 'review-master.mp4'),
             '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-pix_fmt', 'yuv420p', '-an',
             '-movflags', '+faststart', str(out / 'review.mp4')])
        output = out / 'review.mp4'
        info = probe(output)
        rendered_duration = duration(info)
        if abs(rendered_duration - total) > 0.2:
            raise ValueError('Rendered duration differs from raw input by more than 0.2 seconds')
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(output), '-f', 'null', '-'])
        write_json(out / 'ffprobe.json', info)
        (out / 'frames').mkdir()
        for index, at in enumerate(samples):
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-n', '-ss', str(at), '-i', str(output),
                 '-frames:v', '1', str(out / 'frames' / f'{index:02d}-{at:.3f}s.png')])
        manifest.update(status='rendered', video=str(output), bytes=output.stat().st_size,
                        sha256=digest(output), durationSeconds=rendered_duration,
                        sampleTimes=samples, fullDecodePassed=True, muted=True)
    except Exception as error:
        manifest.update(status='failed', error=str(error))
        raise
    finally:
        if client:
            client.close()
        manifest['seconds'] = round(time.monotonic() - started, 3)
        write_json(out / 'manifest.json', manifest)
    print(json.dumps({'status': manifest['status'], 'output': str(out), 'bytes': manifest['bytes'],
                      'productAcceptance': manifest['productAcceptance']}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--openscreen', default=DEFAULT_APP, help='OpenScreen MCP executable')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor', help='Check tools using a temporary, owned stdio connection')
    validate = sub.add_parser('validate', help='Validate recipe, source file and spans')
    validate.add_argument('--input', type=Path, required=True)
    render = sub.add_parser('build', help='Render into a new output directory')
    render.add_argument('--input', type=Path, required=True)
    render.add_argument('--output', type=Path, required=True)
    link = sub.add_parser('preview', help='Issue and verify a scoped Backend preview ticket')
    configure_parser(link, default_kind='video')
    args = parser.parse_args()
    if args.command == 'doctor':
        import tempfile
        dependencies(args.openscreen)
        with tempfile.TemporaryDirectory(prefix='acceptance-doctor-') as directory:
            client = Mcp(args.openscreen, Path(directory))
            try:
                server = client.initialize()
                print(json.dumps({'ready': True, 'openscreenVersion': app_version(args.openscreen),
                                  'server': server.get('serverInfo'), 'requiredToolsAvailable': sorted(REQUIRED)}))
            finally:
                client.close()
    elif args.command == 'validate':
        _, video, total, samples = load_recipe(args.input)
        print(json.dumps({'valid': True, 'video': str(video), 'durationSeconds': total, 'sampleTimes': samples}))
    elif args.command == 'build':
        build(args)
    else:
        if args.token_env and not args.backend:
            parser.error('--token-env requires --backend')
        preview(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        detail = error.stderr[-1500:] if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        print(json.dumps({'error': detail, 'automaticRetry': False}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
