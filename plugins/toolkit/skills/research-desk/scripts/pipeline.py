"""Research state transitions; only independently accepted material is published."""
import datetime as dt
import json
from pathlib import Path
import sys
import uuid

import models
import sources
from storage import ResearchError, admissions, atomic, check, digest, encoded, freeze, now, read_json, relative, validate


def runtime_hash():
    return digest(encoded({p.name: digest(p.read_bytes()) for p in sorted(Path(__file__).parent.glob("*.py"))}))


def scope(config):
    return digest(encoded({k: config[k] for k in ["id", "name", "keywords"]}))


def save(run, state):
    atomic(run / "state.json", encoded(state))


def progress(state, text):
    state["stage"] = text
    print(text, file=sys.stderr, flush=True)


def create_run(topic):
    config = validate(read_json(topic / "topic.json"))
    ident = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
    run = topic / "runs" / ident
    run.mkdir(parents=True, mode=0o700)
    end = dt.datetime.now(dt.timezone.utc)
    state = {"schema_version": 1, "workflow_version": 1, "id": ident, "topic_id": config["id"], "scope": scope(config),
             "created_at": now(), "window": {"start": (end-dt.timedelta(days=config["window_days"])).isoformat(), "end": end.isoformat()},
             "config_sha256": freeze(run / "config.json", encoded(config)), "runtime_sha256": runtime_hash(),
             "status": "ready", "calls": {}, "notes": {}, "selected": [], "skipped": [], "processed": []}
    save(run, state)
    return run


def material(topic, record):
    text = check(relative(topic, record["text_path"]), record["text_sha256"]).decode()
    check(relative(topic, record["raw_path"]), record["raw_sha256"])
    return {"source": record, "full_text": text}


def note(topic, run, state, config, record):
    ident = digest(encoded([record["canonical_url"], record["text_sha256"]]))[:20]
    if ident in state["notes"]:
        result = state["notes"][ident]
        if result.get("path"):
            check(relative(topic, result["path"]), result["sha256"])
        return result
    data = {"topic": config["name"], "keywords": config["keywords"], "material": material(topic, record)}
    for revision in range(2):
        progress(state, "总结与审阅 " + record["title"] + " revision=" + str(revision))
        task = "逐篇研究，不做跨篇综合。若有前次候选和审阅，只做必要修订。这是唯一允许的修订轮次。输出结构：" + json.dumps(models.NOTE_SCHEMA, ensure_ascii=False)
        candidate = models.invoke(run, state, config, "note-" + ident + "-" + str(revision), "generation", "note", task, data)
        review_task = "你未参与生成。在新线程核对候选的主题相关性、事实、归属、对照、推断范围和原文内协议冲突。至少核对机制、结果与限制三条，并给原文位置。篇幅和文风不构成拒收理由。只在无实质问题时pass，有可修问题revise，否则reject。pass时issues为空且全部checks.supported为true。输出结构：" + json.dumps(models.REVIEW_SCHEMA, ensure_ascii=False)
        review = models.invoke(run, state, config, "note-review-" + ident + "-" + str(revision), "review", "review", review_task, dict(data, candidate=candidate))
        if review["decision"] == "pass":
            text = "# " + candidate["title"] + "\n\n" + candidate["markdown"] + "\n\n---\n\n"
            text += "[一手来源](" + record["url"] + ") · [冻结全文](../../../" + record["text_path"] + ")\n\n"
            text += "生成与独立审阅使用不同模型和新线程；实验为作者报告，未复现。\n"
            path = run / "summary" / (ident + ".md")
            result = {"status": "accepted", "source": record, "path": str(path.relative_to(topic)),
                      "sha256": freeze(path, text.encode()), "note": candidate, "revision_count": revision,
                      "review_call": "note-review-" + ident + "-" + str(revision)}
            state["notes"][ident] = result
            save(run, state)
            return result
        if review["decision"] == "reject":
            break
        data.update(previous_candidate=candidate, previous_review=review)
    result = {"status": "rejected", "source": record, "review": review}
    state["notes"][ident] = result
    save(run, state)
    return result


def history(topic, state, config, previous, current):
    if "history" in state:
        return state["history"]
    cutoff = sources.date(state["created_at"]) - dt.timedelta(days=config["history_days"])
    choices, seen = [], {n["source"]["canonical_url"] for n in current}
    size = len(json.dumps(current, ensure_ascii=False)) + sum(len(material(topic, n["source"])["full_text"]) for n in current) + 20000
    for batch in reversed(previous):
        if batch["scope"] != state["scope"] or sources.date(batch["completed_at"]) < cutoff:
            continue
        for item in batch["notes"]:
            if len(choices) >= config["history_limit"]:
                break
            url = item["source"]["canonical_url"]
            if url in seen:
                continue
            full = material(topic, item["source"])
            extra = len(json.dumps(dict(full, accepted_note=item["note"]), ensure_ascii=False))
            if size + extra > config["max_prompt_chars"]:
                continue
            check(relative(topic, item["path"]), item["sha256"])
            choices.append(item)
            seen.add(url)
            size += extra
    state["history"] = choices
    save(topic / "runs" / state["id"], state)
    return choices


def insight(topic, run, state, config, current, previous):
    if "insight" in state:
        return state["insight"]
    old = history(topic, state, config, previous, current)
    if not current or len({n["source"]["canonical_url"] for n in current + old}) < 2:
        result = {"outcome": "no_insight", "title": "本轮没有足够的新证据形成跨篇洞察",
                  "markdown": "本轮新增通过审阅的资料为" + str(len(current)) + "篇，绑定历史资料为" + str(len(old)) + "篇。保留已有总结，不据此制造跨篇结论。", "claims": []}
    else:
        payload = {"topic": config["name"], "current": [dict(material(topic, n["source"]), accepted_note=n["note"]) for n in current],
                   "history": [dict(material(topic, n["source"]), accepted_note=n["note"]) for n in old]}
        allowed = {n["source"]["canonical_url"] for n in current + old}
        for revision in range(2):
            progress(state, "跨篇综合与审阅 revision=" + str(revision))
            task = "结合本轮及明确绑定的历史资料，形成有用的跨篇判断；区分新增证据与既有认识，指出确认、修正与不确定性。综合判断标为本轮推断，每条claims至少两条不同canonical_url互证；不得混合不同基准形成统一排名。证据不足可no_insight。输出结构：" + json.dumps(models.INSIGHT_SCHEMA, ensure_ascii=False)
            candidate = models.invoke(run, state, config, "insight-" + str(revision), "generation", "insight", task, payload)
            for claim in candidate["claims"]:
                refs = claim.get("sources", []) if isinstance(claim, dict) else []
                if len(set(refs)) < 2 or not set(refs) <= allowed:
                    raise ResearchError("跨篇判断未绑定至少两条已读来源")
            if candidate["outcome"] == "insight" and not candidate["claims"]:
                raise ResearchError("洞察缺少可核对的综合判断")
            task = "独立审阅跨篇综合。核对事实、归属、数字、跨文互证和推断边界；至少核对三条关键判断，给原文位置。no_insight可核对证据缺口。不要因篇幅文风拒收。pass要求issues为空且checks全部supported为true。输出结构：" + json.dumps(models.REVIEW_SCHEMA, ensure_ascii=False)
            review = models.invoke(run, state, config, "insight-review-" + str(revision), "review", "review", task, dict(payload, candidate=candidate))
            if review["decision"] == "pass":
                result = dict(candidate, revision_count=revision, review_call="insight-review-" + str(revision))
                break
            if review["decision"] == "reject" or revision == 1:
                result = {"outcome": "no_insight", "title": "跨篇综合未通过独立审阅",
                          "markdown": "候选与审阅意见保留在运行记录中，本轮不将该综合作为正式研究结论。", "claims": [], "review": review}
                break
            payload.update(previous_candidate=candidate, previous_review=review)
    state["insight"] = result
    save(run, state)
    return result


def execute(topic, run):
    state = read_json(run / "state.json")
    config = validate(json.loads(check(run / "config.json", state["config_sha256"])))
    previous = admissions(topic)
    committed = next((record for record in previous if record["run_id"] == state["id"]), None)
    if committed:
        state.update(status="completed", stage="研究完成", report=committed["report"])
        save(run, state)
        return committed
    if state.get("workflow_version", 1) != 1:
        raise ResearchError("执行合同版本变化，保留旧批次，使用兼容版本续跑")
    versions = state.setdefault("runtime_versions", [state["runtime_sha256"]])
    if runtime_hash() not in versions:
        versions.append(runtime_hash())
    if state["status"] == "completed":
        return read_json(run / "accepted.json")
    try:
        state["status"] = "running"
        state.pop("error", None)
        save(run, state)
        if "discovery_sha256" not in state:
            progress(state, "发现候选资料")
            found = sources.discover(config, run, state["window"])
            if all(c["status"] == "unavailable" for c in found["coverage"]):
                raise ResearchError("所有发现来源不可用，未将采集失败当作没有新资料")
            state["discovery_sha256"] = freeze(run / "discovery.json", encoded(found))
            save(run, state)
        found = json.loads(check(run / "discovery.json", state["discovery_sha256"]))
        known = {(n["source"]["canonical_url"], n["source"]["text_sha256"]) for batch in previous
                 if batch["scope"] == state["scope"] for n in batch["notes"] + batch.get("rejected", [])}
        if not state.get("collection_done"):
            failures = []
            for index, candidate in enumerate(found["candidates"]):
                if index in state["processed"] or len(state["selected"]) >= config["max_documents"]:
                    continue
                progress(state, "获取完整正文 " + candidate["url"])
                try:
                    item = sources.extract(config, candidate, topic, found)
                    if (item["canonical_url"], item["text_sha256"]) in known:
                        state["skipped"].append({"url": item["url"], "reason": "同研究范围内相同正文已通过审阅", "text_sha256": item["text_sha256"]})
                    else:
                        state["selected"].append(item)
                    state["processed"].append(index)
                    save(run, state)
                except (OSError, ValueError, ResearchError) as error:
                    failures.append({"url": candidate["url"], "reason": str(error)})
            state["collection_failures"] = failures
            if failures and not state["selected"] and not state["processed"]:
                raise ResearchError("候选全文均获取失败，保留原因；可在恢复来源后续跑")
            state["collection_done"] = True
            freeze(run / "collection.json", encoded({"selected": state["selected"], "duplicates": state["skipped"], "unavailable": failures}))
            state["collection_sha256"] = digest((run / "collection.json").read_bytes())
            save(run, state)
        collection = json.loads(check(run / "collection.json", state["collection_sha256"]))
        if collection["selected"] != state["selected"] or collection["duplicates"] != state["skipped"]:
            raise ResearchError("检查点与冻结采集清单不一致，保留现状并停止")
        accepted = [item for item in [note(topic, run, state, config, row) for row in state["selected"]] if item["status"] == "accepted"]
        synthesis = insight(topic, run, state, config, accepted, previous)
        return publish(topic, run, state, config, found, accepted, synthesis)
    except (Exception, KeyboardInterrupt) as error:
        state.update(status="blocked", error=str(error) or "执行被中断；结果未知的模型调用不会自动重发")
        save(run, state)
        raise


def publish(topic, run, state, config, found, notes, synthesis):
    for record in state["selected"]:
        material(topic, record)
    for item in notes:
        material(topic, item["source"])
        check(relative(topic, item["path"]), item["sha256"])
        generation_call = item["review_call"].replace("note-review-", "note-", 1)
        generated = models.completed(run / "calls" / generation_call, "note")
        reviewed = models.completed(run / "calls" / item["review_call"], "review")
        for call in [generation_call, item["review_call"]]:
            check(run / "calls" / call / "prompt.txt", state["calls"][call]["prompt_sha256"])
        if not generated or not reviewed or generated["value"] != item["note"] or reviewed["value"]["decision"] != "pass" or generated["thread_id"] == reviewed["thread_id"]:
            raise ResearchError("逐篇总结缺少匹配的生成与独立通过回执")
    if synthesis["outcome"] == "insight":
        revision = synthesis["revision_count"]
        generated = models.completed(run / "calls" / ("insight-" + str(revision)), "insight")
        reviewed = models.completed(run / "calls" / synthesis["review_call"], "review")
        for call in ["insight-" + str(revision), synthesis["review_call"]]:
            check(run / "calls" / call / "prompt.txt", state["calls"][call]["prompt_sha256"])
        if not generated or not reviewed or any(generated["value"].get(k) != synthesis.get(k) for k in generated["value"]) or reviewed["value"]["decision"] != "pass" or generated["thread_id"] == reviewed["thread_id"]:
            raise ResearchError("跨篇综合缺少匹配的生成与独立通过回执")
    text = "# " + config["name"] + " 研究\n\n## " + synthesis["title"] + "\n\n" + synthesis["markdown"] + "\n\n## 逐篇精读\n\n"
    for item in notes:
        text += "### " + item["note"]["title"] + "\n\n" + item["note"]["markdown"] + "\n\n[一手原文](" + item["source"]["url"] + ")\n\n"
    text += "## 本轮范围\n\n"
    text += "- 候选窗口：" + found["start"] + " 至 " + found["end"] + "。来源返回及关键词筛选均有覆盖限制。\n"
    text += "- 候选" + str(len(found["candidates"])) + "篇；新增正文" + str(len(state["selected"])) + "篇；总结准入" + str(len(notes)) + "篇；重复跳过" + str(len(state["skipped"])) + "篇；历史绑定" + str(len(state.get("history", []))) + "篇。\n"
    text += "- 未通过审阅的候选、不可读全文和来源缺口保留于[运行记录](state.json)与[发现清单](discovery.json)，不代表完整覆盖或没有其他有价值资料。\n"
    text += "- 完整文字抽取未包含图像像素，所有实验均为作者自报，本轮未复现。\n"
    report_sha = freeze(run / "report.md", text.encode())
    result = {"schema_version": 1, "run_id": state["id"], "scope": state["scope"], "completed_at": now(),
              "outcome": synthesis["outcome"], "report": str((run / "report.md").relative_to(topic)),
              "notes": notes, "sources": [item["source"] for item in notes],
              "rejected": [item for item in state["notes"].values() if item["status"] == "rejected"],
              "history": state.get("history", []), "duplicates": len(state["skipped"]),
              "model_turns": len(state["calls"]), "calls": state["calls"],
              "runtime_versions": state.get("runtime_versions", [state["runtime_sha256"]]),
              "input_hashes": {"config.json": state["config_sha256"], "discovery.json": state["discovery_sha256"], "collection.json": state["collection_sha256"]},
              "output_hashes": {str((run / "report.md").relative_to(topic)): report_sha, **{item["path"]: item["sha256"] for item in notes}}}
    freeze(run / "accepted.json", encoded(result))
    state.update(status="completed", stage="研究完成", report=result["report"])
    save(run, state)
    return result
