import { skillIdentity } from "./evidence.mjs";

export function aggregate(sessions) {
  const skills = new Map(),
    seen = new Set();
  const aliases = new Map();
  for (const session of sessions)
    for (const event of session.events) {
      if (event.status !== "confirmed") continue;
      const directoryId = skillIdentity(event.path).id;
      if (!aliases.has(directoryId)) aliases.set(directoryId, event.id);
      else if (aliases.get(directoryId) !== event.id)
        aliases.set(directoryId, null);
    }
  let duplicates = 0;
  for (const session of [...sessions].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  )) {
    for (const original of session.events) {
      const id = aliases.get(skillIdentity(original.path).id) ?? original.id;
      const event = { ...original, id, name: id.split(":").at(-1) };
      const key = `${event.turnId}\0${event.callId}\0${event.path}\0${event.timestamp}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      if (!skills.has(event.id))
        skills.set(event.id, {
          id: event.id,
          name: event.name,
          paths: new Set(),
          rounds: new Map(),
          sessions: new Set(),
          readCount: 0,
          lastLoadedAt: null,
          lastRelatedAt: null,
          evidence: [],
        });
      const skill = skills.get(event.id);
      const round = `${session.id}/${event.turnId}`;
      skill.paths.add(event.path);
      skill.sessions.add(session.id);
      if (event.status === "confirmed" || !skill.rounds.has(round))
        skill.rounds.set(round, event.status);
      if (event.reason === "successful-body-read") skill.readCount++;
      if (
        event.status === "confirmed" &&
        (!skill.lastLoadedAt ||
          Date.parse(event.timestamp) > Date.parse(skill.lastLoadedAt))
      )
        skill.lastLoadedAt = event.timestamp;
      if (
        !skill.lastRelatedAt ||
        Date.parse(event.timestamp) > Date.parse(skill.lastRelatedAt)
      )
        skill.lastRelatedAt = event.timestamp;
      skill.evidence.push({ sessionId: session.id, ...event });
    }
  }
  return {
    duplicateEvidence: duplicates,
    skills: [...skills.values()]
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        paths: [...skill.paths].sort(),
        confirmedTurns: [...skill.rounds.values()].filter(
          (s) => s === "confirmed",
        ).length,
        candidateTurns: [...skill.rounds.values()].filter(
          (s) => s === "candidate",
        ).length,
        sessionCount: skill.sessions.size,
        readCount: skill.readCount,
        lastLoadedAt: skill.lastLoadedAt,
        lastRelatedAt: skill.lastRelatedAt,
        evidence: skill.evidence,
      }))
      .sort(
        (a, b) =>
          b.confirmedTurns - a.confirmedTurns ||
          b.candidateTurns - a.candidateTurns ||
          a.id.localeCompare(b.id),
      ),
  };
}

const cell = (value) => String(value ?? "未知").replace(/[|\r\n]/g, " ");

export function markdown(report) {
  const lines = [
    "# Codex Skill 使用报告",
    "",
    `范围：${report.project?.root ?? "本机全部项目"}`,
    `时间：${report.since} 至 ${report.until}`,
    `纳入 ${report.sessions.length} 个已结束会话、${report.turnCount} 个轮次。`,
    "",
    "显式和隐式合并统计；确认加载不等于工作流成功。候选关联不是调用次数。",
    "",
    "| Skill | 确认加载轮次 | 候选关联轮次 | 涉及会话 | 成功读取调用数 | 最近加载 |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const skill of report.skills)
    lines.push(
      `| ${cell(skill.id)} | ${skill.confirmedTurns} | ${skill.candidateTurns} | ${skill.sessionCount} | ${skill.readCount} | ${cell(skill.lastLoadedAt)} |`,
    );
  if (!report.skills.length)
    lines.push("", "没有识别到 Skill 加载或候选关联；不代表没有使用。");
  lines.push("", "## 证据", "");
  for (const skill of report.skills) {
    lines.push(`### ${cell(skill.id)}`, "");
    for (const event of skill.evidence)
      lines.push(
        `- ${event.status === "confirmed" ? "确认加载" : "候选关联"} (${event.reason})：${event.file}:${event.line}${event.resultLine ? `；结果行 ${event.resultLine}` : ""}；${event.timestamp}`,
      );
    lines.push("");
  }
  lines.push(
    "## 数据覆盖",
    "",
    `扫描 ${report.scan.inspected} 份日志，忽略 ${report.scan.duplicateEvidence} 条重复证据。`,
  );
  for (const [reason, count] of Object.entries(report.scan.excluded))
    lines.push(`- 排除 ${reason}：${count}`);
  for (const item of report.scan.skipped)
    lines.push(`- 读取失败：${item.file} (${item.reason})`);
  for (const session of report.sessions)
    if (
      session.coverage.invalidRecords ||
      session.coverage.inheritedRecords ||
      session.coverage.unassignedInjections
    )
      lines.push(
        `- ${session.id}：${session.coverage.invalidRecords} 条无法解析；${session.coverage.inheritedRecords} 条继承记录已忽略；${session.coverage.unassignedInjections} 次注入未关联轮次。`,
      );
  lines.push(
    "",
    "沿用已加载上下文、部分读取、动态命令和未留存日志可能漏计。只处理历史数据，不执行日志命令，不调用模型或服务。",
    "",
  );
  return lines.join("\n");
}
