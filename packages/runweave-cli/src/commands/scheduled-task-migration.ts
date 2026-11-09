import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ScheduledTaskCapabilities, ScheduledTaskMigrationPreview } from "@runweave/shared/scheduled-tasks";
import { getStringOption, parseArgs, requireStringOption, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

export async function runScheduledTaskMigrationCommand(args: string[], io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv }): Promise<void> {
  const [operation, ...rest] = args;
  if (operation !== "preview" && operation !== "apply") throw new CliError("Usage: rw scheduled-task migration <preview --file path|apply --file path --sha256 digest --expected-backend url --idempotency-key key> [--json]", 2);
  const { options, positionals } = parseArgs(rest, new Set(["json", "plain"]));
  const allowed = new Set(["instance", "config-dir", "profile", "backend-port", "json", "plain", "file", ...(operation === "apply" ? ["sha256", "expected-backend", "idempotency-key"] : [])]);
  if (positionals.length || Object.keys(options).some(key => !allowed.has(key))) throw new CliError("Invalid migration options", 2);
  const auth = await resolveAuthContext({ profileName: getStringOption(options, "profile"), backendPort: getStringOption(options, "backend-port"), env: io.env });
  const capabilities = await auth.requestJson<ScheduledTaskCapabilities>("/api/scheduled-tasks/capabilities");
  if (capabilities.taskContextVersion !== 2) throw new CliError("定时任务协议不兼容，请更新 Backend", 2);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Runweave-Task-Context-Version": "2" };
  const file = requireStringOption(options, "file");
  if (operation === "preview") {
    const preview = await auth.requestJson<ScheduledTaskMigrationPreview>("/api/scheduled-tasks/migration/preview", { method: "POST", headers, body: "{}" });
    const body = { backend: auth.baseUrl, preview, request: { expectedDatabaseDigest: preview.databaseDigest, tasks: preview.tasks.filter(task => task.action !== "convert-quick-origin").map(task => ({ id: task.id, expectedRevision: task.revision, prompt: task.prompt })) } };
    const bytes = JSON.stringify(body, null, 2) + "\n";
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    writeOutput(io.stdout, resolveOutputMode(options), { ...body, file, sha256: hash(bytes) });
    return;
  }
  const bytes = await readFile(file, "utf8");
  if (hash(bytes) !== requireStringOption(options, "sha256").toLowerCase()) throw new CliError("迁移文件已变化，请重新核对完整草稿及摘要", 2);
  const body = JSON.parse(bytes) as { backend?: string; request?: unknown };
  if (auth.baseUrl !== requireStringOption(options, "expected-backend") || body.backend !== auth.baseUrl) throw new CliError("目标 Backend 与迁移草稿不一致", 2);
  const key = requireStringOption(options, "idempotency-key");
  if (!key.trim() || key.length > 200 || !body.request) throw new CliError("无效迁移草稿或幂等键", 2);
  headers["Idempotency-Key"] = key;
  const result = await auth.requestJson("/api/scheduled-tasks/migration/apply", { method: "POST", headers, body: JSON.stringify(body.request) });
  writeOutput(io.stdout, resolveOutputMode(options), result);
}

function hash(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
