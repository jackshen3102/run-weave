import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  addUsage,
  emptyUsage,
  listLogs,
  projectScope,
  readSession,
} from "./logs.mjs";
import { casePacket, markdown } from "./report.mjs";

const USAGE = `用法：pnpm token:report [--cwd PATH] [--days 30 | --since ISO_DATE] [--json] [--case ID]
  --sessions-dir PATH  指定本机 Codex JSONL 日志目录（默认同时读取 sessions、archived_sessions）
  --json               输出机器可读的完整 JSON 报告
  --case ID            输出该疑点的局部证据与分析请求；不调用模型
  --days N             读取最近 N 天的全部本项目会话（默认 30 天）
  --since ISO_DATE     仅统计此 UTC 时间以后的用量增量；日期格式 YYYY-MM-DD 或 ISO 8601
日志只读，结果写 stdout；不会连接 Backend、模型或其他网络服务。`;

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      days: { type: "string" },
      since: { type: "string" },
      "sessions-dir": { type: "string" },
      json: { type: "boolean" },
      case: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (values.days && values.since)
    throw new Error("--days 与 --since 不能同时使用");
  const days = Number(values.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("--days 必须为 1–3650 的整数");
  const since = values.since
    ? Date.parse(values.since)
    : Date.now() - days * 86_400_000;
  if (!Number.isFinite(since)) throw new Error("--since 不是有效日期");
  const started = performance.now();
  const project = await projectScope(values.cwd ?? process.cwd());
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = values["sessions-dir"]
    ? [path.resolve(values["sessions-dir"])]
    : [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  const { files, unavailable } = await listLogs(roots, since);
  const scan = {
    inspected: 0,
    excluded: {},
    skipped: unavailable.map((item) => ({
      file: item.path,
      reason: item.reason,
    })),
    durationMs: 0,
  };
  const sessions = [],
    seen = new Set(),
    usage = emptyUsage();
  for (const file of files) {
    scan.inspected++;
    try {
      const session = await readSession(file, project, since);
      if (session.excluded) {
        scan.excluded[session.excluded] =
          (scan.excluded[session.excluded] ?? 0) + 1;
        if (
          !/其他项目|审批评估|时间范围|仍在进行/.test(
            session.excluded,
          )
        )
          scan.skipped.push({ file: file.file, reason: session.excluded });
        continue;
      }
      if (seen.has(session.id)) {
        scan.excluded.duplicateSession =
          (scan.excluded.duplicateSession ?? 0) + 1;
        continue;
      }
      seen.add(session.id);
      sessions.push(session);
      addUsage(usage, session.usage);
    } catch (error) {
      scan.skipped.push({
        file: file.file,
        reason: error.code ?? error.message,
      });
    }
  }
  scan.durationMs = Math.round(performance.now() - started);
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    project,
    since: new Date(since).toISOString(),
    usage,
    sessions,
    scan,
    modelAnalysis: { status: "not_run", usage: null },
  };
  if (values.case)
    process.stdout.write(
      `${JSON.stringify(await casePacket(report, values.case), null, 2)}\n`,
    );
  else
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : markdown(report),
    );
}

main().catch((error) => {
  process.stderr.write(`token:report: ${error.message}\n`);
  process.exitCode = 1;
});
