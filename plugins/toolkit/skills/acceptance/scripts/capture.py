#!/usr/bin/env python3
"""Prepare a Playwright CLI capture wrapper; encode real timestamped frames."""
import argparse
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
from common import duration, number, probe, run, write_json


def prepare(args):
    action = args.actions.read_text().strip().rstrip(';')
    if '=>' not in action or not action.startswith('async'):
        raise ValueError('actions must contain one async arrow function, not a module')
    number(args.fps, 1, 10, 'fps')
    clip = None
    if args.clip:
        values = [float(x) for x in args.clip.split(',')]
        if len(values) != 4 or min(values[:2]) < 0 or min(values[2:]) <= 0:
            raise ValueError('clip must be x,y,width,height with positive dimensions')
        for index, value in enumerate(values):
            number(value, 0 if index < 2 else 0.001, 100000, 'clip coordinate')
        clip = dict(zip(('x', 'y', 'width', 'height'), values))
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / 'frames').mkdir()
    write_json(out / 'capture-plan.json', {'actions': str(args.actions.resolve()), 'maxFps': args.fps,
                                          'clip': clip, 'requires': 'repository-pinned playwright cli run-code'})
    # This expression is evaluated by the existing Playwright CLI page, never launches a browser itself.
    code = '''async page => {
  const perform = ACTION;
  const frames = [];
  const startPage = {url: await page.url(), title: await page.title(), viewport: page.viewportSize()};
  const captureStartedAt = Date.now();
  const clock = {now: () => (Date.now() - captureStartedAt) / 1000};
  let running = true;
  let captureError;
  const shot = async () => {
    const atSeconds = frames.length ? clock.now() : 0;
    const path = FRAME_ROOT + '/' + String(frames.length).padStart(6, '0') + '.png';
    await page.screenshot({path, fullPage: false, ...CLIP});
    frames.push({path, atSeconds});
  };
  await shot();
  const recorder = (async () => {
    try {
      while (running) {
        await page.waitForTimeout(INTERVAL);
        if (running) await shot();
      }
    } catch (error) {captureError = error; running = false;}
  })();
  let result;
  try {result = await perform(page, clock);}
  finally {running = false; await recorder;}
  if (captureError) throw captureError;
  await shot();
  return {schemaVersion: 1, captureMethod: 'playwright-viewport-screenshot-loop',
    startedAt: new Date(captureStartedAt).toISOString(), endedAt: new Date().toISOString(),
    durationSeconds: clock.now(), viewport: page.viewportSize(), startPage,
    endPage: {url: await page.url(), title: await page.title(), viewport: page.viewportSize()}, clip: CLIP_VALUE,
    maxFps: FPS_VALUE, frames, actions: result ?? null,
    limitation: 'Sampled screenshots, not high-FPS animation or latency evidence'};
}'''
    # Replace unique markers before injecting the task's actual action code.
    for key, value in [('FRAME_ROOT', json.dumps(str(out / 'frames'))),
                       ('CLIP_VALUE', json.dumps(clip)), ('CLIP', json.dumps({'clip': clip} if clip else {})),
                       ('INTERVAL', str(1000 / args.fps)), ('FPS_VALUE', str(args.fps))]:
        code = code.replace(key, value)
    code = code.replace('ACTION', '(' + action + ')')
    (out / 'run-code.js').write_text(code)
    print(json.dumps({'script': str(out / 'run-code.js'), 'maxFps': args.fps,
                      'next': 'Run with owned playwright cli session; save --raw result as capture.json'}))


def encode(args):
    data = json.loads(args.input.read_text())
    if data.get('schemaVersion') != 1 or data.get('captureMethod') != 'playwright-viewport-screenshot-loop':
        raise ValueError('Expected successful capture.py result, not CLI errors or a snapshot')
    total = number(data.get('durationSeconds'), 0.001, 86400, 'durationSeconds')
    frames = data.get('frames', [])
    if len(frames) < 2:
        raise ValueError('At least two captured frames are required')
    if args.output.exists():
        raise FileExistsError('Refusing to overwrite an existing recording')
    times, paths = [], []
    for frame in frames:
        at = number(frame.get('atSeconds'), 0, total, 'frame.atSeconds')
        if times and at <= times[-1]:
            raise ValueError('Frame timestamps must increase strictly')
        path = (args.input.resolve().parent / frame['path']).resolve(strict=True)
        if not path.is_file():
            raise ValueError('Frame path must be a file')
        times.append(at)
        paths.append(path)
    if times[0] != 0:
        raise ValueError('First frame must start at zero')
    concat = args.output.with_suffix('.ffconcat')
    lines = ['ffconcat version 1.0']
    for i, path in enumerate(paths):
        quoted = str(path).replace("'", "'\\''")
        end = times[i + 1] if i + 1 < len(times) else total
        lines.extend([f"file '{quoted}'", f'duration {max(end - times[i], 1 / 30):.6f}'])
    lines.append("file '" + str(paths[-1]).replace("'", "'\\''") + "'")
    with concat.open('x') as f:
        f.write('\n'.join(lines) + '\n')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-n', '-safe', '0', '-i', str(concat),
         '-t', str(total), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p', '-r', '30',
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-movflags', '+faststart', str(args.output)])
    actual = duration(probe(args.output))
    if abs(actual - total) > 0.1:
        raise ValueError('Encoded duration does not match captured duration')
    print(json.dumps({'recording': str(args.output.resolve()), 'durationSeconds': actual,
                      'capturedFrames': len(frames), 'timing': 'measured frame timestamps, rounded to 30 FPS'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    make = sub.add_parser('prepare', help='Wrap real actions without starting a browser')
    make.add_argument('--actions', type=Path, required=True)
    make.add_argument('--output', type=Path, required=True)
    make.add_argument('--fps', type=float, default=4)
    make.add_argument('--clip', help='Observed viewport region: x,y,width,height')
    movie = sub.add_parser('encode', help='Encode successful CLI capture result, preserving frame timing')
    movie.add_argument('--input', type=Path, required=True)
    movie.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args) if args.command == 'prepare' else encode(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
