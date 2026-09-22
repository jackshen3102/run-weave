#!/usr/bin/env python3
"""YouTube source preparation; the calling Agent performs review and translation."""
import argparse
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True

import artifacts as a
import runtime as r


def normalize_url(url):
    try:
        p = urlparse(url)
        port = p.port
    except ValueError as e:
        raise a.JobError('INVALID_URL', '无效的视频链接。') from e
    if (p.scheme not in {'https', 'http'} or p.hostname not in
            {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'} or
            p.username or p.password or port not in {None, 443, 80} or
            re.search(r'[\s<>"\x27;|\\]', url)):
        raise a.JobError('INVALID_URL', '仅支持 YouTube 单视频链接。')
    if p.hostname.endswith('youtu.be'):
        video_id = p.path.lstrip('/')
    elif p.path == '/watch':
        video_id = parse_qs(p.query).get('v', [''])[0]
    elif p.path.startswith('/shorts/'):
        video_id = p.path[len('/shorts/'):]
    else:
        video_id = ''
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
        raise a.JobError('INVALID_URL', '链接缺少有效 video ID；频道与纯播放列表不受支持。')
    return video_id, 'https://www.youtube.com/watch?v=' + video_id


def save(work, manifest):
    manifest['updated_at'] = a.now()
    a.write_json(work / 'manifest.json', manifest)


def status(job, manifest, cache_hit=False):
    return {'status': manifest['stage'], 'job_dir': str(job), 'manifest': str(job / '.work/manifest.json'),
            'cache_hit': cache_hit, 'acquired_at': manifest.get('acquired_at'),
            'next': 'review chunks, write review.json and guide.txt, then finalize' if manifest['stage'] == 'awaiting_ai' else None,
            'reading': str(job / 'reading.md') if manifest['stage'] == 'complete' else None,
            'quality_hints': manifest.get('quality_hints', [])}


def require_runtime(root):
    result = r.doctor(root)
    if not result['ok']:
        raise a.JobError('RUNTIME_INVALID', '; '.join(result['issues']))


def material_identity():
    return a.identity({'runtime_lock': r.LOCK, 'material_version': 4})


def prepare(url, output_root, runtime_root, timeout_seconds=None, adapter=None):
    video_id, canonical = normalize_url(url)
    runtime_root = Path(runtime_root).expanduser().resolve()
    job = Path(output_root).expanduser().resolve() / video_id
    work = job / '.work'
    with a.job_lock(work):
        manifest_path = work / 'manifest.json'
        manifest = a.read_json(manifest_path) if manifest_path.exists() else {
            'schema_version': 1, 'video_id': video_id, 'canonical_url': canonical,
            'original_url': url, 'stage': 'acquiring', 'created_at': a.now(),
            'quality_hints': [], 'completed_blocks': [], 'timings': {}}
        manifest['runtime_root'] = str(Path(runtime_root).expanduser().resolve())
        manifest['timeout_seconds'] = timeout_seconds
        save(work, manifest)
        try:
            require_runtime(runtime_root)
            source_path = work / 'source.json'
            current_material = material_identity()
            materials_valid = all(not manifest.get(key) or (path.exists() and a.digest(path) == manifest[key])
                                  for key, path in [('metadata_sha256', work / 'metadata.json'),
                                                    ('captions_sha256', work / 'captions.raw.json'),
                                                    ('audio_sha256', Path(manifest.get('audio_path') or work / 'missing-audio'))])
            incomplete = any(h.startswith('INCOMPLETE_GAP_CHECK:') for h in manifest['quality_hints'])
            source_valid = (not incomplete and materials_valid and source_path.exists() and manifest.get('source_sha256') == a.digest(source_path)
                            and manifest.get('material_identity') == current_material)
            if source_valid:
                a.validate_source(a.read_json(source_path))
                same_review = manifest.get('prompt_version') == a.PROMPT_VERSION and manifest.get('contract_version') == a.CONTRACT_VERSION
                complete = (manifest['stage'] == 'complete' and same_review and (job / 'reading.md').exists()
                            and manifest.get('reading_sha256') == a.digest(job / 'reading.md'))
                manifest.update(stage='complete' if complete else 'awaiting_ai', prompt_version=a.PROMPT_VERSION,
                                contract_version=a.CONTRACT_VERSION)
                manifest['chunks'] = a.chunk_source(source_path, work)
                manifest['last_cache_hit_at'] = a.now()
                manifest.pop('error', None)
                manifest.pop('resume_from', None)
                save(work, manifest)
                return status(job, manifest, True)
            manifest['stage'] = 'acquiring'
            manifest['quality_hints'] = []
            save(work, manifest)
            adapter = adapter or r.NetworkAdapter(runtime_root, work)
            info_path = work / 'metadata.json'
            acquired_start = time.monotonic()
            if info_path.exists() and manifest.get('metadata_sha256') == a.digest(info_path):
                info = a.read_json(info_path)
            else:
                info = r.acquire_metadata(canonical, adapter)
                if info.get('is_live') or not info.get('duration'):
                    raise a.JobError('UNSUPPORTED_VIDEO', '不支持直播或时长未知的视频。')
                a.write_json(info_path, info)
                manifest['metadata_sha256'] = a.digest(info_path)
                manifest['acquired_at'] = a.now()
            language = info.get('language')
            if not language:
                # yt-dlp marks the original auto-caption language with an -orig track.
                original = [k[:-5] for k in info.get('automatic_captions', {}) if k.endswith('-orig')]
                language = original[0] if len(original) == 1 else None
            manifest.update(title=info.get('title') or video_id, channel=info.get('channel') or info.get('uploader'),
                            duration_ms=round(info['duration']*1000), source_language=language,
                            tool_model_lock=r.LOCK, material_identity=current_material)
            save(work, manifest)
            captions_path = work / 'captions.raw.json'
            if captions_path.exists() and manifest.get('captions_sha256') == a.digest(captions_path):
                captions = a.read_json(captions_path)
            else:
                try:
                    captions = adapter.transcripts(video_id, language)
                except Exception as e:
                    captions = {'tracks': [], 'segments': [], 'language': language, 'source_kind': None,
                                'error': type(e).__name__}
                    manifest['quality_hints'].append('CAPTIONS_UNAVAILABLE: ' + type(e).__name__)
                a.write_json(captions_path, captions)
                manifest['captions_sha256'] = a.digest(captions_path)
                save(work, manifest)
            if captions.get('error'):
                manifest['quality_hints'].append('CAPTIONS_UNAVAILABLE: ' + captions['error'])
            segments = []
            for x in captions['segments']:
                text = x['text'].strip()
                if text and x['duration'] > 0:
                    segments.append({'start_ms': round(x['start']*1000),
                                     'end_ms': min(manifest['duration_ms'], round((x['start']+x['duration'])*1000)),
                                     'text': text, 'language': captions['language'], 'source_kind': captions['source_kind']})
            segments = sorted([x for x in segments if x['end_ms'] > x['start_ms']], key=lambda x: x['start_ms'])
            if segments and (sum(len(x['text']) for x in segments)/max(1, info['duration']) > 80 or
                             any('\ufffd' in x['text'] for x in segments)):
                manifest['quality_hints'].append('CAPTIONS_DISTORTED')
                segments = []
            gaps = r.caption_gaps(segments, manifest['duration_ms'])
            if gaps or not segments:
                audio_path = Path(manifest['audio_path']) if manifest.get('audio_path') else None
                try:
                    if not audio_path or not audio_path.exists() or a.digest(audio_path) != manifest.get('audio_sha256'):
                        audio_path = adapter.audio(canonical)
                        manifest.update(audio_path=str(audio_path), audio_sha256=a.digest(audio_path))
                        save(work, manifest)
                    wav = r.convert_audio(audio_path, work)
                    manifest['wav_sha256'] = a.digest(wav)
                except Exception as e:
                    if not segments:
                        raise a.JobError('AUDIO_ACQUISITION_FAILED', '音频获取失败：' + type(e).__name__) from e
                    manifest['quality_hints'].append('INCOMPLETE_GAP_CHECK: ' + type(e).__name__)
                    wav = None
                manifest['timings']['acquisition_seconds'] = round(time.monotonic()-acquired_start, 3)
                if wav:
                    manifest['stage'] = 'transcribing'
                    save(work, manifest)
                    def checkpoint(block, hit):
                        row = {k: v for k, v in block.items() if k not in {'segments', 'boundary_candidates'}}
                        row['cache_hit'] = hit
                        manifest['completed_blocks'] = [b for b in manifest['completed_blocks']
                                                        if (b['key'], b['core_start_ms']) != (row['key'], row['core_start_ms'])] + [row]
                        save(work, manifest)
                        print(json.dumps({'stage': 'transcribing', 'core_end_ms': row['core_end_ms'], 'cache_hit': hit}), file=sys.stderr, flush=True)
                    options = {'runtime_root': runtime_root, 'language': (language or 'auto').split('-')[0],
                               'timeout_seconds': timeout_seconds, 'on_chunk': checkpoint}
                    started = time.monotonic()
                    segments = (r.fill_gaps(segments, wav, work, options) if segments else
                                r.transcribe_audio(wav, work / 'asr', options))
                    manifest['timings']['asr_seconds'] = round(time.monotonic()-started, 3)
            for i, s in enumerate(segments):
                s['id'] = f's{i:06d}'
            source = {'schema_version': 1, 'segments': segments}
            a.validate_source(source)
            a.write_json(source_path, source)
            manifest.update(source_sha256=a.digest(source_path), stage='awaiting_ai',
                            prompt_version=a.PROMPT_VERSION, contract_version=a.CONTRACT_VERSION)
            manifest['chunks'] = a.chunk_source(source_path, work)
            manifest['quality_hints'] = sorted(set(manifest['quality_hints']))
            manifest.pop('error', None)
            manifest.pop('resume_from', None)
            save(work, manifest)
            return status(job, manifest)
        except Exception as e:
            manifest.update(resume_from=manifest['stage'], stage='failed',
                            error={'code': getattr(e, 'code', 'PROCESS_ERROR'), 'message': str(e)})
            save(work, manifest)
            raise


def retranscribe(job, start_ms, end_ms):
    work = job / '.work'
    with a.job_lock(work):
        manifest = a.read_json(work / 'manifest.json')
        require_runtime(manifest['runtime_root'])
        wav = work / 'audio.wav'
        if not wav.exists() or a.digest(wav) != manifest.get('wav_sha256'):
            raise a.JobError('AUDIO_MISSING', '重识别需要当前任务经过校验的音频。')
        duration = r.audio_duration(wav)
        if not 0 <= start_ms < end_ms <= duration or end_ms-start_ms > 50000:
            raise a.JobError('RETRY_RANGE', '异常核心区间最多 50 秒；加前后 5 秒后最多 60 秒。')
        start, end = max(0, start_ms-5000), min(duration, end_ms+5000)
        record_id = f'retry-{start}-{end}'
        path = work / 'retranscriptions' / (record_id + '.json')
        if path.exists():
            old = a.read_json(path)
            if old.get('source_sha256') == manifest['source_sha256'] and old.get('audio_sha256') == manifest['wav_sha256']:
                return {'status': 'candidate', 'path': str(path), 'cache_hit': True}
        rows = r.transcribe_audio(wav, work / 'retranscriptions/audio',
                                 {'runtime_root': manifest['runtime_root'], 'language': (manifest.get('source_language') or 'auto').split('-')[0],
                                  'start_ms': start, 'end_ms': end, 'vad': False, 'context_ms': 0,
                                  'timeout_seconds': manifest.get('timeout_seconds')})
        a.write_json(path, {'schema_version': 1, 'id': record_id, 'start_ms': start, 'end_ms': end,
                            'source_sha256': manifest['source_sha256'], 'audio_sha256': manifest['wav_sha256'],
                            'segments': rows, 'created_at': a.now()})
        return {'status': 'candidate', 'path': str(path), 'cache_hit': False}


def finalize(job, review_path, guide_path):
    work = job / '.work'
    with a.job_lock(work):
        manifest = a.read_json(work / 'manifest.json')
        source_path = work / 'source.json'
        if manifest.get('material_identity') and manifest['material_identity'] != material_identity():
            raise a.JobError('SOURCE_VERSION', '材料处理版本已变化，请先 resume 再校对。')
        if a.digest(source_path) != manifest.get('source_sha256'):
            raise a.JobError('SOURCE_CHANGED', '来源已变化，请 resume 后重新校对。')
        source, review = a.read_json(source_path), a.read_json(review_path)
        guide = Path(guide_path).read_text(encoding='utf-8')
        changes = a.validate_review(source, review, manifest, work)
        article = a.render(manifest, source, review, guide)
        # Validate everything before touching an earlier successful deliverable.
        manifest['stage'] = 'finalizing'
        save(work, manifest)
        try:
            a.write_json(work / 'review.json', review)
            a.atomic_write(work / 'guide.txt', guide)
            a.write_json(work / 'review-changes.json', changes)
            a.atomic_write(job / 'reading.md', article)
            manifest.update(stage='complete', reading_sha256=a.digest(job / 'reading.md'), completed_at=a.now(),
                            prompt_version=a.PROMPT_VERSION, contract_version=a.CONTRACT_VERSION,
                            needs_review=bool(manifest.get('quality_hints')) or any(x['action'] == 'uncertain' for x in review['segments']))
            manifest.pop('error', None)
            manifest.pop('resume_from', None)
            save(work, manifest)
            return status(job, manifest)
        except OSError as e:
            manifest.update(stage='failed', resume_from='finalizing',
                            error={'code': 'FINALIZE_WRITE_FAILED', 'message': str(e)})
            save(work, manifest)
            raise a.JobError('FINALIZE_WRITE_FAILED', str(e)) from e


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('doctor', 'setup', 'prepare'):
        p = sub.add_parser(name)
        p.add_argument('--runtime-root', type=Path, default=r.DEFAULT_ROOT)
        if name == 'prepare':
            p.add_argument('--url', required=True)
            p.add_argument('--output-root', type=Path, default=Path.home() / 'Documents/YouTube阅读稿')
            p.add_argument('--asr-timeout-seconds', type=float)
    for name in ('resume', 'retranscribe', 'finalize'):
        p = sub.add_parser(name)
        p.add_argument('--job-dir', type=Path, required=True)
        if name == 'retranscribe':
            p.add_argument('--start-ms', type=int, required=True)
            p.add_argument('--end-ms', type=int, required=True)
        if name == 'finalize':
            p.add_argument('--review', type=Path, required=True)
            p.add_argument('--guide', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'doctor':
            result = r.doctor(args.runtime_root.expanduser().resolve())
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result['ok'] else 1
        if args.command == 'setup':
            result = r.setup(args.runtime_root)
        elif args.command == 'prepare':
            result = prepare(args.url, args.output_root, args.runtime_root, args.asr_timeout_seconds)
        else:
            job = args.job_dir.expanduser().resolve()
            if args.command == 'resume':
                manifest = a.read_json(job / '.work/manifest.json')
                result = prepare(manifest['canonical_url'], job.parent, manifest['runtime_root'], manifest.get('timeout_seconds'))
            elif args.command == 'retranscribe':
                result = retranscribe(job, args.start_ms, args.end_ms)
            else:
                result = finalize(job, args.review, args.guide)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (a.JobError, OSError, ValueError, KeyError, TypeError) as e:
        print(json.dumps({'status': 'failed', 'error_code': getattr(e, 'code', 'INVALID_ARTIFACT'), 'message': str(e)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
