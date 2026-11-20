"""Private, append-only research material and serialized topic execution."""
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


class ResearchError(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".research-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def freeze(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        if path.read_bytes() != data:
            raise ResearchError("保留已存在的不同内容，不覆盖: " + str(path))
    else:
        # Topic lock serializes publishers. Readers see only complete files.
        atomic(path, data)
    return digest(data)


def check(path, expected):
    path = Path(path)
    if not path.is_file() or digest(path.read_bytes()) != expected:
        raise ResearchError("文件缺失或已修改，保留现状并停止: " + str(path))
    return path.read_bytes()


def identifier(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value):
        raise ResearchError("方向/运行ID须为1–64位小写字母、数字和连字符")
    return value


def relative(root, value):
    root = Path(root).resolve()
    path = (root / value).resolve()
    if not path.is_relative_to(root):
        raise ResearchError("材料路径越出资料库")
    return path


@contextlib.contextmanager
def locked(topic):
    topic.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (topic / ".lock").open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ResearchError("该方向已有执行者；查看状态或等待它结束") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def admissions(topic):
    result = []
    for path in sorted((topic / "runs").glob("*/accepted.json")):
        item = read_json(path)
        if item.get("schema_version") != 1:
            raise ResearchError("不支持的研究准入版本: " + str(path))
        for name, expected in item["output_hashes"].items():
            check(relative(topic, name), expected)
        for name, expected in item["input_hashes"].items():
            check(relative(path.parent, name), expected)
        for source in item["sources"] + [n["source"] for n in item.get("rejected", [])]:
            check(relative(topic, source["text_path"]), source["text_sha256"])
            check(relative(topic, source["raw_path"]), source["raw_sha256"])
        result.append(item)
    return sorted(result, key=lambda item: item["completed_at"])


def defaults(slug, name):
    return {
        "schema_version": 1, "id": slug, "name": name,
        "keywords": ["agent memory", "long-term memory", "episodic memory"],
        "window_days": 60, "candidate_limit": 80, "max_documents": 5,
        "history_days": 180, "history_limit": 30,
        "generation_model": "gpt-6.2-sol", "review_model": "gpt-6-astra",
        "max_model_turns": 24, "model_timeout_seconds": 600,
        "max_prompt_chars": 600000, "max_source_chars": 200000,
        "sources": [
            {"kind": "arxiv"},
            {"kind": "sitemap", "url": "https://www.letta.com/sitemap.xml"},
            {"kind": "sitemap", "url": "https://www.langchain.com/sitemap.xml"},
            {"kind": "rss", "url": "https://huggingface.co/blog/feed.xml"},
            {"kind": "rss", "url": "https://tech.meituan.com/feed/"},
        ],
    }


def validate(config):
    if config.get("schema_version") != 1:
        raise ResearchError("配置schema_version必须为1")
    identifier(config["id"])
    for name in ["name", "generation_model", "review_model"]:
        if not isinstance(config.get(name), str) or not config[name].strip():
            raise ResearchError("配置缺少非空字段: " + name)
    if config["generation_model"] == config["review_model"]:
        raise ResearchError("生成和审阅必须配置不同模型")
    limits = {"window_days": (1, 365), "candidate_limit": (1, 80),
              "max_documents": (1, 5), "history_days": (1, 365), "history_limit": (0, 30),
              "max_model_turns": (1, 100), "model_timeout_seconds": (30, 1800),
              "max_prompt_chars": (10000, 1000000), "max_source_chars": (1000, 200000)}
    for name, (minimum, maximum) in limits.items():
        value = config.get(name)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ResearchError("配置整数越界: " + name)
    if not isinstance(config.get("keywords"), list) or not config["keywords"]:
        raise ResearchError("至少配置一个主题关键词")
    if any(not isinstance(word, str) or not word.strip() for word in config["keywords"]):
        raise ResearchError("关键词必须为非空字符串")
    if not isinstance(config.get("sources"), list) or not 1 <= len(config["sources"]) <= 12:
        raise ResearchError("配置1–12个来源")
    for source in config["sources"]:
        if source.get("kind") not in {"arxiv", "rss", "sitemap", "url"}:
            raise ResearchError("不支持的来源类型")
        if source["kind"] != "arxiv" and not isinstance(source.get("url"), str):
            raise ResearchError("来源缺少URL")
    return config
