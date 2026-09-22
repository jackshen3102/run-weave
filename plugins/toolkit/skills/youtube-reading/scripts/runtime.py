"""Private macOS runtime and bounded network/ASR operations. No shell commands."""
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
import wave

from artifacts import JobError, digest, identity, job_lock, now, read_json, write_json

SKILL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = Path.home() / 'Library/Application Support/youtube-reading'
LOCK = read_json(SKILL_ROOT / 'assets/runtime-lock.json')


def run(args, log, timeout=120):
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('a', encoding='utf-8') as f:
        try:
            p = subprocess.run([str(a) for a in args], stdout=f, stderr=f, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise JobError('PROCESS_TIMEOUT', f'进程超时；日志：{log}')
    if p.returncode:
        raise JobError('PROCESS_FAILED', f'进程退出 {p.returncode}；日志：{log}')


def active(root):
    path = Path(root) / 'active.json'
    if not path.exists():
        raise JobError('RUNTIME_MISSING', '尚未安装专用运行时，请执行 setup。')
    release = read_json(path)['release']
    if not re.fullmatch(r'[a-zA-Z0-9-]+', release):
        raise JobError('RUNTIME_INVALID', '运行时版本指针无效。')
    return Path(root) / 'releases' / release


def tool_version(tool):
    path = shutil.which(tool)
    if not path:
        return {'path': None, 'version': None}
    flag = '-version' if tool in {'ffmpeg', 'ffprobe'} else '--version'
    try:
        p = subprocess.run([path, flag], capture_output=True, text=True, timeout=15)
        return {'path': path, 'version': (p.stdout or p.stderr).splitlines()[0]}
    except (OSError, subprocess.SubprocessError, IndexError):
        return {'path': path, 'version': None}


def doctor(root=DEFAULT_ROOT, release=None):
    issues, checks = [], {}
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        issues.append('requires macOS Apple Silicon')
    if sys.version_info < (3, 10):
        issues.append('requires Python >=3.10')
    for tool in ('ffmpeg', 'ffprobe', 'cmake', 'node', 'clang', 'curl'):
        checks[tool] = tool_version(tool)
        if not checks[tool]['version']:
            issues.append('missing tool: ' + tool)
    for tool, minimum in [('ffmpeg', (7, 0)), ('ffprobe', (7, 0)), ('node', (22, 0)), ('cmake', (3, 21))]:
        version = checks[tool]['version'] or ''
        match = re.search(r'(\d+)\.(\d+)', version)
        if match and tuple(map(int, match.groups())) < minimum:
            issues.append(f'{tool} requires >= {minimum[0]}.{minimum[1]}')
    try:
        release = Path(release) if release else active(root)
        receipt = read_json(release / 'receipt.json')
        if receipt['lock_sha256'] != identity(LOCK):
            issues.append('runtime lock changed; run setup')
        for rel, expected in receipt['files'].items():
            file = release / rel
            if not file.is_file() or digest(file) != expected:
                issues.append('checksum mismatch: ' + rel)
        for model in LOCK['models']:
            file = release / 'models' / model['name']
            checks[model['name']] = {'sha256': digest(file) if file.exists() else None,
                                      'expected': model['sha256']}
            if checks[model['name']]['sha256'] != model['sha256']:
                issues.append('model checksum mismatch: ' + model['name'])
        code = 'import importlib.metadata,json; print(json.dumps({n:importlib.metadata.version(n) for n in ' + repr([x['name'] for x in LOCK['python_packages']]) + '}))'
        p = subprocess.run([str(release / 'venv/bin/python'), '-c', code], capture_output=True, text=True, timeout=20)
        versions = json.loads(p.stdout) if p.returncode == 0 else {}
        checks['python_packages'] = versions
        for x in LOCK['python_packages']:
            if versions.get(x['name']) != x['version']:
                issues.append('package version mismatch: ' + x['name'])
        binary = release / 'whisper/build/bin/whisper-cli'
        version = subprocess.run([str(binary), '--version'], capture_output=True, text=True, timeout=15)
        checks['whisper_binary_version'] = (version.stdout + version.stderr).strip()
        if version.returncode or LOCK['whisper']['version'] not in checks['whisper_binary_version']:
            issues.append('whisper binary version mismatch')
        checks['release'] = str(release)
        checks['whisper'] = LOCK['whisper']
    except (JobError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        issues.append(str(e))
    return {'ok': not issues, 'runtime_root': str(Path(root).resolve()), 'checks': checks, 'issues': issues}


def download(url, path, sha256, log):
    path = Path(path)
    if path.exists() and digest(path) == sha256:
        return
    temp = path.with_suffix(path.suffix + '.part')
    run(['curl', '-4', '--http1.1', '--fail', '--location', '--silent', '--show-error',
         '--connect-timeout', '15', '--max-time', '900', '--retry', '2',
         '--output', temp, url], log, timeout=2750)
    if digest(temp) != sha256:
        raise JobError('CHECKSUM_MISMATCH', f'下载摘要不匹配：{path.name}')
    os.replace(temp, path)


def setup(root=DEFAULT_ROOT):
    root = Path(root).expanduser().resolve()
    with job_lock(root):
        existing = doctor(root)
        if existing['ok']:
            return {**existing, 'cache_hit': True}
        missing = [x for x in existing['issues'] if x.startswith(('requires ', 'missing tool:')) or ' requires >= ' in x]
        if missing:
            raise JobError('SETUP_PREREQUISITE', '; '.join(missing))
        release = root / 'releases' / (identity(LOCK)[:12] + '-' + uuid.uuid4().hex[:8])
        release.mkdir(parents=True)
        cache = root / 'downloads'
        cache.mkdir(exist_ok=True)
        log = release / 'setup.log'
        run([sys.executable, '-m', 'venv', release / 'venv'], log)
        for x in LOCK['python_packages']:
            download(x['url'], cache / x['filename'], x['sha256'], log)
        run([release / 'venv/bin/python', '-m', 'pip', 'install', '--no-index', '--no-deps',
             '--require-hashes', '--find-links', cache, '-r', SKILL_ROOT / 'requirements.lock'], log)
        archive = cache / (LOCK['whisper']['commit'] + '.tar.gz')
        download(LOCK['whisper']['url'], archive, LOCK['whisper']['sha256'], log)
        source = release / 'whisper'
        source.mkdir()
        with tarfile.open(archive) as tar:
            # Extract files only, dropping archive prefix and forbidding links/traversal.
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                rel = Path(*Path(member.name).parts[1:])
                if rel.is_absolute() or '..' in rel.parts:
                    raise JobError('ARCHIVE_INVALID', '源码归档含不安全路径。')
                dest = source / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as src, dest.open('wb') as out:
                    shutil.copyfileobj(src, out)
        run(['cmake', '-S', source, '-B', source / 'build', '-DCMAKE_BUILD_TYPE=Release',
             '-DGGML_METAL=ON', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
             '-DWHISPER_BUILD_COMMIT=' + LOCK['whisper']['commit']], log, 180)
        run(['cmake', '--build', source / 'build', '--config', 'Release', '-j', '4'], log, 600)
        (release / 'models').mkdir()
        for model in LOCK['models']:
            download(model['url'], cache / model['name'], model['sha256'], log)
            shutil.copy2(cache / model['name'], release / 'models' / model['name'])
        files = {}
        for file in (source / 'build').rglob('*'):
            if file.is_file() and (file.suffix == '.dylib' or file.name == 'whisper-cli'):
                files[str(file.relative_to(release))] = digest(file)
        write_json(release / 'receipt.json', {'schema_version': 1, 'lock_sha256': identity(LOCK),
                                             'installed_at': now(), 'files': files})
        result = doctor(root, release)
        if not result['ok']:
            raise JobError('SETUP_VERIFICATION', '; '.join(result['issues']))
        write_json(root / 'active.json', {'release': release.name})
        return result


def activate_python(root):
    release = active(root)
    site = list((release / 'venv/lib').glob('python*/site-packages'))
    if not site:
        raise JobError('RUNTIME_MISSING', '缺少 Python 专用环境。')
    sys.path.insert(0, str(site[0]))
    return release


class NetworkAdapter:
    """Inject this boundary for isolated failures; production uses real requests."""
    def __init__(self, root, work):
        activate_python(root)
        import requests
        import urllib3.util.connection
        urllib3.util.connection.HAS_IPV6 = False
        class Session(requests.Session):
            def request(self, *args, **kwargs):
                kwargs['timeout'] = 15
                for attempt in range(3):
                    try:
                        response = super().request(*args, **kwargs)
                        response.raise_for_status()
                        return response
                    except (requests.Timeout, requests.ConnectionError):
                        if attempt == 2:
                            raise
        self.session = Session()
        self.work = Path(work)

    def metadata(self, url):
        import yt_dlp
        with yt_dlp.YoutubeDL(self.options()) as ydl:
            return ydl.extract_info(url, download=False)

    def options(self):
        adapter = self
        class Logger:
            def debug(self, msg):
                pass
            def warning(self, msg):
                self.error(msg)
            def error(self, msg):
                with (adapter.work / 'network.log').open('a') as f:
                    f.write(msg + '\n')
        return {'quiet': True, 'no_warnings': True, 'logger': Logger(), 'noplaylist': True,
                'source_address': '0.0.0.0', 'socket_timeout': 15, 'retries': 2,
                'fragment_retries': 2, 'extractor_retries': 2, 'file_access_retries': 2,
                'js_runtimes': {'node': {'path': shutil.which('node')}},
                'cachedir': str(self.work / 'yt-cache')}

    def transcripts(self, video_id, language):
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
        try:
            tracks = list(YouTubeTranscriptApi(http_client=self.session).list(video_id))
        except (TranscriptsDisabled, NoTranscriptFound):
            return {'tracks': [], 'segments': [], 'language': language, 'source_kind': None}
        inventory = [{'language': t.language_code, 'generated': t.is_generated} for t in tracks]
        # A known original language is mandatory; do not choose translated manual tracks.
        prefix = (language or '').split('-')[0]
        matching = [t for t in tracks if prefix and t.language_code.split('-')[0] == prefix]
        matching.sort(key=lambda t: t.is_generated)
        if not matching:
            return {'tracks': inventory, 'segments': [], 'language': language, 'source_kind': None}
        t = matching[0]
        rows = t.fetch().to_raw_data()
        return {'tracks': inventory, 'segments': rows, 'language': t.language_code,
                'source_kind': 'automatic_caption' if t.is_generated else 'manual_caption'}

    def audio(self, url):
        import yt_dlp
        options = {**self.options(), 'format': 'bestaudio/best',
                   'outtmpl': str(self.work / 'audio.%(ext)s')}
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            return Path(ydl.prepare_filename(info))


def acquire_metadata(url, adapter):
    # Adapters own request retries (three attempts, 15 s each). Do not multiply retries.
    try:
        return adapter.metadata(url)
    except Exception as e:
        name = type(e).__name__
        code = 'NETWORK_TIMEOUT' if 'timeout' in name.lower() else 'ACQUISITION_DENIED'
        raise JobError(code, '获取元数据失败：' + name) from e


def convert_audio(audio, work):
    dest = Path(work) / 'audio.wav'
    stamp = Path(work) / 'audio-conversion.json'
    input_hash = digest(audio)
    if stamp.exists() and dest.exists():
        saved = read_json(stamp)
        if saved.get('input_sha256') == input_hash and saved.get('sha256') == digest(dest):
            return dest
    temp = dest.with_name('audio.pending.wav')
    run(['ffmpeg', '-v', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', temp],
        Path(work) / 'ffmpeg.log', 600)
    os.replace(temp, dest)
    write_json(stamp, {'input_sha256': input_hash, 'sha256': digest(dest)})
    return dest


def audio_duration(path):
    with wave.open(str(path), 'rb') as wav:
        return round(wav.getnframes() / wav.getframerate() * 1000)


def transcribe_audio(audio_path, work_dir, options):
    """Same resumable core for CLI and local audio acceptance. options: runtime_root,
    language (auto default), start_ms/end_ms, vad, timeout_seconds, on_chunk callback.
    Each core <=600 s; reconcile unowned boundary candidates after all cores finish.
    """
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    release = active(options.get('runtime_root', DEFAULT_ROOT))
    duration = audio_duration(audio_path)
    start = options.get('start_ms', 0)
    end = min(options.get('end_ms', duration), duration)
    if not 0 <= start < end:
        raise JobError('AUDIO_RANGE', '无效音频时间区间。')
    settings = {k: v for k, v in options.items() if k not in {'on_chunk', 'runtime_root'}}
    key = identity({'audio_sha256': digest(audio_path), 'lock': identity(LOCK),
                    'settings': settings, 'boundary_version': 1})
    result, boundary_candidates = [], []
    for core_start in range(start, end, 600000):
        core_end = min(core_start + 600000, end)
        context = options.get('context_ms', 2000)
        clip_start = max(0, core_start - context)
        clip_end = min(duration, core_end + context)
        name = f'{core_start}-{core_end}'
        directory = work / key[:16]
        directory.mkdir(exist_ok=True)
        receipt = directory / (name + '.done.json')
        if receipt.exists():
            saved = read_json(receipt)
            output = directory / (name + '.json')
            if saved.get('key') == key and output.exists() and digest(output) == saved['sha256']:
                result.extend(saved['segments'])
                boundary_candidates.extend(saved['boundary_candidates'])
                if options.get('on_chunk'):
                    options['on_chunk'](saved, True)
                continue
        clip = directory / (name + '.wav')
        with wave.open(str(audio_path), 'rb') as src, wave.open(str(clip), 'wb') as out:
            out.setparams(src.getparams())
            src.setpos(round(clip_start * src.getframerate() / 1000))
            out.writeframes(src.readframes(round((clip_end-clip_start) * src.getframerate() / 1000)))
        output_prefix = directory / name
        timeout = options.get('timeout_seconds') or max(120, (clip_end-clip_start) / 2000)
        args = [release / 'whisper/build/bin/whisper-cli', '-m', release / 'models' / LOCK['models'][0]['name'],
                '-f', clip, '-l', options.get('language', 'auto'), '-t', '4', '-oj', '-of', output_prefix]
        if options.get('vad', True):
            args += ['--vad', '-vm', release / 'models' / LOCK['models'][1]['name']]
        started = time.monotonic()
        try:
            run(args, directory / (name + '.log'), timeout)
        except JobError as e:
            if e.code == 'PROCESS_TIMEOUT':
                raise JobError('ASR_TIMEOUT', str(e)) from e
            raise
        raw = read_json(directory / (name + '.json'))
        rows, candidates = [], []
        for item in raw.get('transcription', []):
            a = clip_start + item['offsets']['from']
            b = min(clip_end, clip_start + item['offsets']['to'])
            text = item['text'].strip()
            if text and b > a and a < core_end and b > core_start:
                target = rows if core_start <= (a+b)/2 < core_end else candidates
                target.append({'start_ms': a, 'end_ms': b, 'text': text,
                               'language': raw.get('result', {}).get('language', options.get('language', 'auto')),
                               'source_kind': 'ASR', 'core_start_ms': core_start,
                               'raw_path': str(directory / (name + '.json'))})
        saved = {'key': key, 'sha256': digest(directory / (name + '.json')), 'segments': rows,
                 'boundary_candidates': candidates,
                 'core_start_ms': core_start, 'core_end_ms': core_end, 'timeout_seconds': timeout,
                 'elapsed_seconds': round(time.monotonic()-started, 3), 'completed_at': now()}
        write_json(receipt, saved)
        result.extend(rows)
        boundary_candidates.extend(candidates)
        if options.get('on_chunk'):
            options['on_chunk'](saved, False)
    # Independent timestamps can put the same sentence outside BOTH owning
    # cores. Retain those candidates until all cores are available; restoring
    # a candidate also covers its counterpart, so it is not restored twice.
    for candidate in sorted(boundary_candidates, key=lambda x: x['end_ms']-x['start_ms'], reverse=True):
        midpoint = (candidate['start_ms'] + candidate['end_ms']) / 2
        if start <= midpoint < end and not any(s['start_ms'] <= midpoint < s['end_ms'] for s in result):
            result.append({**candidate, 'boundary_recovery': True})
    result.sort(key=lambda x: x['start_ms'])
    # Only trim a literal repeated boundary prefix when different core windows
    # claim the same audio time. Keep raw text/times as provenance. Ordinary
    # repetitions within one window or at distinct times remain untouched.
    for previous, current in zip(result, result[1:]):
        overlap = previous['end_ms'] - current['start_ms']
        if previous['core_start_ms'] == current['core_start_ms'] or overlap < 500:
            continue
        left = re.sub(r'[\s，,。.!！?？]', '', previous['text'])
        right = current['text']
        for n in range(min(len(left), len(right)), 3, -1):
            if left.endswith(right[:n]) and n < len(right):
                current['boundary_overlap'] = {
                    'original_text': right, 'removed_prefix': right[:n],
                    'overlap_ms': overlap, 'retained_raw_path': previous['raw_path']}
                current['text'] = right[n:].lstrip('，,。 ')
                current['start_ms'] = previous['end_ms']
                break
    if options.get('vad', True) and options.get('recover_gaps', True):
        # Language can change mid-clip. Re-detect language in uncovered intervals
        # using VAD, once only; silence remains empty rather than hallucinated.
        covered = [{'start_ms': max(start, x['start_ms'])-start,
                    'end_ms': min(end, x['end_ms'])-start} for x in result]
        for gap_start, gap_end in caption_gaps(covered, end-start):
            recovered = transcribe_audio(audio_path, work / 'coverage', {
                **options, 'start_ms': start+gap_start, 'end_ms': start+gap_end,
                'language': 'auto', 'context_ms': 0, 'recover_gaps': False})
            for segment in recovered:
                segment['coverage_recovery'] = True
            result.extend(recovered)
        result.sort(key=lambda x: x['start_ms'])
    return result


def caption_gaps(segments, duration_ms):
    cursor, gaps = 0, []
    for s in sorted(segments, key=lambda x: x['start_ms']):
        if s['start_ms']-cursor > 3000:
            gaps.append((cursor, s['start_ms']))
        cursor = max(cursor, s['end_ms'])
    if duration_ms-cursor > 3000:
        gaps.append((cursor, duration_ms))
    return gaps


def fill_gaps(segments, audio, work, options):
    gaps = caption_gaps(segments, audio_duration(audio))
    additions = []
    for a, b in gaps:
        rows = transcribe_audio(audio, Path(work) / 'gaps', {
            **options, 'start_ms': a, 'end_ms': b, 'vad': True, 'context_ms': 0})
        # Feed only missing audio: clipping timestamps cannot remove words
        # spoken in neighbouring captions. Keep ASR timestamps as provenance.
        for r in rows:
            r = {**r, 'source_kind': 'gap_fill'}
            if r['end_ms'] > r['start_ms']:
                additions.append(r)
    write_json(Path(work) / 'gap-check.json', {'schema_version': 1, 'candidates': gaps, 'additions': additions})
    return sorted(segments + additions, key=lambda x: x['start_ms'])
