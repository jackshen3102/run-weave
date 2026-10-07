import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { listLogs, projectScope } from "../token-report/logs.mjs";
import { readSkillSession } from "./logs.mjs";
import { aggregate, markdown } from "./report.mjs";

const HELP = `用法：pnpm skill:report [--days 7 | --since ISO_DATE] [--all-projects | --cwd PATH] [--json]
  --days N            最近 N 天（默认 7；可用 30）
  --since ISO_DATE    指定起始时间；YYYY-MM-DD 按 UTC 解释
  --all-projects      本机全部项目，不要求当前目录属于 Git 仓库
  --cwd PATH          当前 Git 项目、worktree 及其子目录
  --sessions-dir PATH 替换默认 sessions、archived_sessions 日志来源
  --json              输出含证据行号和覆盖说明的 JSON
只读本机 Codex 历史；显式和隐式合并。默认排除仍在进行及审批评估会话。`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      days: { type: "string" },
      since: { type: "string" },
      "all-projects": { type: "boolean" },
      cwd: { type: "string" },
      "sessions-dir": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (values.days && values.since)
    throw new Error("--days 与 --since 不能同时使用");
  if (values.cwd && values["all-projects"])
    throw new Error("--cwd 与 --all-projects 不能同时使用");
  const days = Number(values.days ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("--days 必须为 1–3650 的整数");
  const until = Date.now();
  const since = values.since
    ? Date.parse(values.since)
    : until - days * 86_400_000;
  if (!Number.isFinite(since) || since > until)
    throw new Error("--since 必须为有效的过去日期");
  const project = values["all-projects"]
    ? null
    : await projectScope(values.cwd ?? process.cwd());
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = values["sessions-dir"]
    ? [path.resolve(values["sessions-dir"])]
    : [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  const started = performance.now();
  const { files, unavailable } = await listLogs(roots, since);
  const scan = {
    inspected: 0,
    excluded: {},
    skipped: unavailable.map((i) => ({ file: i.path, reason: i.reason })),
  };
  const sessions = [],
    seen = new Set();
  for (const file of files) {
    scan.inspected++;
    try {
      const session = await readSkillSession(file, project, since, until);
      const excluded =
        session.excluded ?? (seen.has(session.id) ? "重复会话" : null);
      if (excluded) {
        scan.excluded[excluded] = (scan.excluded[excluded] ?? 0) + 1;
        continue;
      }
      seen.add(session.id);
      sessions.push(session);
    } catch (error) {
      scan.skipped.push({
        file: file.file,
        reason: error.code ?? error.message,
      });
    }
  }
  const result = aggregate(sessions);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    project,
    turnCount: sessions.reduce((n, s) => n + s.turns.length, 0),
    skills: result.skills,
    sessions: sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      parentSessionId: session.parentSessionId,
      turns: session.turns,
      coverage: session.coverage,
    })),
    scan: {
      ...scan,
      duplicateEvidence: result.duplicateEvidence,
      durationMs: Math.round(performance.now() - started),
    },
  };
  process.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : markdown(report),
  );
}

main().catch((error) => {
  process.stderr.write(`skill:report: ${error.message}\n`);
  process.exitCode = 1;
});
