# /// script
# requires-python = ">=3.10"
# dependencies = ["beautifulsoup4==4.15.0", "pypdf==6.7.1"]
# ///
"""Local research entry point. stdout is JSON; no daemon or implicit schedules."""
import argparse
import datetime as dt
import json
from pathlib import Path
import shutil
import signal
import sys

sys.dont_write_bytecode = True

from storage import ResearchError, admissions, defaults, digest, encoded, freeze, identifier, locked, read_json, validate
from pipeline import create_run, execute


def output(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def install():
    source = Path(__file__).resolve().parents[1]
    target = Path.home() / ".agents/skills/research-desk"
    files = {str(p.relative_to(source)): p.read_bytes() for p in source.rglob("*")
             if p.is_file() and (p.suffix in {".py", ".md"}) and "__pycache__" not in p.parts}
    hashes = {name: digest(data) for name, data in files.items()}
    marker = target / ".research-desk-install.json"
    if target.exists():
        if not marker.exists():
            raise ResearchError("用户技能目录已有非本安装器管理的内容，保留不覆盖: " + str(target))
        old = read_json(marker)
        if any(not (target/name).is_file() or digest((target/name).read_bytes()) != sha for name,sha in old["hashes"].items()):
            raise ResearchError("已安装技能有人工修改，保留不覆盖")
        if old["hashes"] == hashes:
            return {"status": "already_installed", "skill": str(target / "SKILL.md")}
    staging = target.parent / (".research-desk-stage-" + __import__("uuid").uuid4().hex)
    for name, data in files.items():
        freeze(staging/name, data)
    freeze(staging/".research-desk-install.json", encoded({"source": str(source), "hashes": hashes}))
    if target.exists():
        backup = Path.home()/".local/share/research-desk/skill-backups"/dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        backup.parent.mkdir(parents=True,exist_ok=True)
        target.rename(backup)
    staging.rename(target)
    return {"status": "installed", "skill": str(target / "SKILL.md")}


def locate(args):
    return Path(args.library).expanduser().resolve() / "topics" / identifier(args.topic)


def runs(topic):
    return sorted((topic / "runs").glob("*/state.json"), reverse=True)


def status(topic):
    values = [read_json(path) for path in runs(topic)]
    return {"topic": str(topic), "runs": [{k: value.get(k) for k in ["id", "status", "stage", "report", "error"]} for value in values],
            "unfinished": [value["id"] for value in values if value["status"] != "completed"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", default=str(Path.home() / "Documents" / "ResearchDesk" / "library"))
    parser.add_argument("--topic", default="agent-memory")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    sub.add_parser("install")
    init = sub.add_parser("init")
    init.add_argument("--name", default="Agent Memory")
    init.add_argument("--config", type=Path)
    sub.add_parser("run")
    resume = sub.add_parser("resume")
    resume.add_argument("--run")
    sub.add_parser("status")
    show = sub.add_parser("report")
    show.add_argument("--run")
    sub.add_parser("shortcuts")
    args = parser.parse_args()
    if args.command == "install":
        output(install())
        return
    if args.command == "doctor":
        import bs4
        import pypdf
        output({"python": sys.version.split()[0], "beautifulsoup4": bs4.__version__, "pypdf": pypdf.__version__,
                "codex": shutil.which("codex"), "platform": sys.platform,
                "supported": sys.platform in {"darwin", "linux"} and bool(shutil.which("codex")),
                "authentication": "使用现有Codex登录；doctor不调用模型、不修改认证或创建任务"})
        return
    topic = locate(args)
    if args.command == "init":
        config = validate(read_json(args.config) if args.config else defaults(args.topic, args.name))
        if config["id"] != args.topic:
            raise ResearchError("配置id必须与--topic一致")
        with locked(topic):
            freeze(topic / "topic.json", encoded(config))
        output({"topic": str(topic), "config": str(topic / "topic.json")})
        return
    if not (topic / "topic.json").exists():
        raise ResearchError("方向尚未配置，先运行init")
    if args.command == "status":
        output(status(topic))
        return
    if args.command == "report":
        accepted = admissions(topic)
        if args.run:
            accepted = [record for record in accepted if record["run_id"] == identifier(args.run)]
        if not accepted:
            raise ResearchError("没有已准入的研究报告")
        record = accepted[-1]
        output({"run_id": record["run_id"], "outcome": record["outcome"], "report": str(topic / record["report"])})
        return
    if args.command == "shortcuts":
        # Natural-language entries load the installed skill's own script location.
        # Do not persist an ephemeral plugin-cache or a checkout path into Backend.
        entries = []
        for title, intent in [("研究一次", "run"), ("继续上次研究", "resume")]:
            skill = Path.home()/".agents/skills/research-desk/SKILL.md"
            if not skill.exists():
                raise ResearchError("先运行install，再生成稳定用户技能入口")
            data = "读取研究Skill " + str(skill) + " 并执行" + intent + "。研究方向ID：" + args.topic + "；资料库：" + str(topic.parent.parent) + "。沿用已保存配置，不改变定时任务，不修改其他项目。若resume返回nothing_to_resume，正常完成并提示使用研究一次，不自动新建批次、不请求启动确认；有报告时给出路径、实际状态与证据缺口。"
            entries.append({"title": title + " · " + args.topic, "data": data, "mode": "line"})
        output({"entries": entries, "registration": "通过现有快捷指令创建API或rw quick-input create保存；此命令只生成内容，不创建日程。"})
        return
    with locked(topic):
        pending = status(topic)["unfinished"]
        if args.command == "run":
            if pending:
                raise ResearchError("已有未结束批次，先resume；避免绕过结果未知的模型调用: " + pending[0])
            run = create_run(topic)
        else:
            if not args.run and len(pending) > 1:
                raise ResearchError("存在多个未完成批次，请用--run选择，不自动接管其他批次")
            selected = args.run or (pending[0] if pending else None)
            if not selected:
                output({"status": "nothing_to_resume", "message": "没有未完成批次；创建新研究请用run"})
                return
            run = topic / "runs" / identifier(selected)
        result = execute(topic, run)
        output({"status": "completed", "run_id": result["run_id"], "outcome": result["outcome"],
                "report": str(topic / result["report"]), "accepted_summaries": len(result["notes"]),
                "duplicates": result["duplicates"], "history_documents": len(result["history"]),
                "model_turns": result["model_turns"]})


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt("执行被中断，保留调用回执后停止")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (ResearchError, OSError, ValueError, KeyboardInterrupt) as error:
        output({"status": "blocked", "error": str(error) or "执行被中断，请查看状态并续跑"})
        sys.exit(2)
