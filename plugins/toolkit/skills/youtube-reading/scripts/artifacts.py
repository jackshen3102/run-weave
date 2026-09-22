"""Versioned artifacts, atomic writes and mechanical (not semantic) review gates."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from datetime import datetime, timezone

SCHEMA_VERSION = 1
PROMPT_VERSION = '1'
CONTRACT_VERSION = '1'


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_json(path, value):
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


@contextlib.contextmanager
def job_lock(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    # Keep the inode: flock releases on death, including SIGKILL, without stale
    # PID reuse or lock-unlink races between competing writers.
    with (directory / '.lock').open('a+') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise JobError('JOB_BUSY', '任务正在运行，请稍后 resume。')
        try:
            f.seek(0)
            f.truncate()
            f.write(json.dumps({'pid': os.getpid(), 'acquired_at': now()}))
            f.flush()
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def validate_source(source):
    if not isinstance(source, dict) or source.get('schema_version') != SCHEMA_VERSION:
        raise JobError('SOURCE_SCHEMA', '不支持的 source schema。')
    previous = -1
    ids = set()
    if not isinstance(source.get('segments'), list) or not all(isinstance(s, dict) for s in source['segments']):
        raise JobError('SOURCE_SCHEMA', 'segments 必须为段落对象数组。')
    for s in source['segments']:
        if (not isinstance(s['id'], str) or s['id'] in ids or
                not isinstance(s['text'], str) or not s['text'].strip() or
                not isinstance(s['start_ms'], int) or not isinstance(s['end_ms'], int) or
                s['start_ms'] < 0 or s['start_ms'] < previous or s['end_ms'] <= s['start_ms']):
            raise JobError('SOURCE_INVALID', '来源 ID、时间顺序或文本无效。')
        ids.add(s['id'])
        previous = s['start_ms']


def chunk_source(source_path, work_dir):
    source = read_json(source_path)
    validate_source(source)
    segments = source['segments']
    groups, current, size = [], [], 0
    for s in segments:
        if len(s['text']) > 6000:
            raise JobError('SEGMENT_TOO_LARGE', '单个来源段超过 6000 字符；先按来源时间拆段。')
        if current and size + len(s['text']) > 6000:
            groups.append(current)
            current, size = [], 0
        current.append(s)
        size += len(s['text'])
    if current:
        groups.append(current)
    out, offset = [], 0
    root = Path(work_dir) / 'chunks'
    root.mkdir(parents=True, exist_ok=True)
    for i, group in enumerate(groups):
        path = root / f'{i:04d}.json'
        write_json(path, {'schema_version': 1, 'source_sha256': digest(source_path),
                         'core': group, 'context_read_only': {
                             'before': segments[max(0, offset-2):offset],
                             'after': segments[offset+len(group):offset+len(group)+2]}})
        out.append({'path': str(path), 'sha256': digest(path), 'segment_ids': [s['id'] for s in group]})
        offset += len(group)
    for stale in root.glob('*.json'):
        if stale.name not in {Path(x['path']).name for x in out}:
            stale.unlink()
    return out


def timestamp(ms):
    seconds = ms // 1000
    return f'{seconds//3600:02d}:{seconds//60%60:02d}:{seconds%60:02d}'


def plain(text):
    # External text is data, including Markdown headings and HTML from videos.
    return re.sub(r'([\\*_{}\[\]<>#])', r'\\\1', ' '.join(text.split())).replace(chr(96), '\\' + chr(96))


def validate_review(source, review, manifest, work_dir):
    validate_source(source)
    if not isinstance(review, dict):
        raise JobError('REVIEW_SCHEMA', 'review 必须为 JSON 对象。')
    if (review.get('schema_version') != 1 or
            review.get('source_sha256') != manifest['source_sha256'] or
            review.get('prompt_version') != PROMPT_VERSION or
            review.get('contract_version') != CONTRACT_VERSION):
        raise JobError('REVIEW_VERSION', '校对来源摘要或处理版本不匹配。')
    rows = review.get('segments', [])
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise JobError('REVIEW_SCHEMA', 'segments 必须为校对对象数组。')
    if [r.get('segment_id') for r in rows] != [s['id'] for s in source['segments']]:
        raise JobError('REVIEW_COVERAGE', '每个来源段必须按顺序恰好映射一次。')
    kept = {r['segment_id'] for r in rows if r.get('action') != 'remove_duplicate'}
    by_id = {s['id']: s for s in source['segments']}
    changes = []
    for s, r in zip(source['segments'], rows):
        action, text = r.get('action'), r.get('text_zh')
        if action not in {'keep', 'correct', 'translate', 'uncertain', 'remove_duplicate'} or not isinstance(text, str):
            raise JobError('REVIEW_INVALID', '无效的 action 或 text_zh。')
        if not isinstance(r.get('reason'), str) or (action != 'keep' and not r['reason'].strip()):
            raise JobError('REVIEW_REASON', '修改必须解释依据。')
        if action == 'remove_duplicate':
            record_id = r.get('retranscription_id', '')
            if not re.fullmatch(r'retry-\d+-\d+', record_id):
                raise JobError('DUPLICATE_EVIDENCE', '删除重复必须引用局部重识别记录。')
            p = Path(work_dir) / 'retranscriptions' / (record_id + '.json')
            evidence = read_json(p) if p.exists() else {}
            retained = by_id.get(r.get('retained_segment_id'))
            if (r.get('retained_segment_id') not in kept or not retained or
                    evidence.get('source_sha256') != manifest['source_sha256'] or
                    not evidence.get('segments') or
                    not all(evidence.get('start_ms', 1) <= x['start_ms'] < x['end_ms'] <= evidence.get('end_ms', 0)
                            for x in (s, retained))):
                raise JobError('DUPLICATE_EVIDENCE', '证据必须覆盖删除段和保留段且对应当前来源。')
        elif not text.strip():
            raise JobError('REVIEW_EMPTY', '正文不能为空。')
        if action == 'keep' and text != s['text']:
            raise JobError('REVIEW_ACTION', 'keep 不得修改原文。')
        if action == 'uncertain' and not re.search(r'\[听辨不清，\d{2,}:[0-5]\d:[0-5]\d\]', text):
            raise JobError('UNCERTAINTY_MARKER', '不确定段必须保留带时间的听辨不清标记。')
        before = re.findall(r'\d+(?:[.,]\d+)*|不|没|无|未|别|not\b|never\b|no\b', s['text'], re.I)
        after = re.findall(r'\d+(?:[.,]\d+)*|不|没|无|未|别|not\b|never\b|no\b', text, re.I)
        if before != after and action != 'remove_duplicate':
            if not str(r.get('reason', '')).strip():
                raise JobError('INVARIANT_EXPLANATION', '数字或否定变化需要解释。')
            changes.append({'segment_id': s['id'], 'before': before, 'after': after, 'reason': r['reason']})
    return changes


def render(manifest, source, review, guide):
    if not guide.strip() or re.search(r'^\s*#{1,6}\s|<\s*/?\s*h[1-6]\b', guide, re.M | re.I):
        raise JobError('GUIDE_STRUCTURE', '导读必须为不带标题的正文。')
    lines = ['# ' + plain(manifest['title']), '',
             f"来源：{manifest['canonical_url']}；频道：{plain(manifest.get('channel') or '未知')}；时长：{timestamp(manifest['duration_ms'])}", '']
    if manifest.get('quality_hints') or any(r['action'] == 'uncertain' for r in review['segments']):
        lines += ['说明：存在待核对片段；材料完整性与听辨标记请结合原视频核对。', '']
    lines += ['## 导读', '', plain(guide), '', '## 正文', '']
    for s, r in zip(source['segments'], review['segments']):
        if r['action'] != 'remove_duplicate':
            lines += [f"[{timestamp(s['start_ms'])}] {plain(r['text_zh'])}", '']
    if not source['segments']:
        lines += ['未识别到可确认的口述内容。', '']
    return '\n'.join(lines)
