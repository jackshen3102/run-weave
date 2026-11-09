import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ApplyScheduledTaskMigrationRequest, ScheduledTaskMigrationPreview, ScheduledTaskMigrationReceipt } from "@runweave/shared/scheduled-tasks";
import { SCHEDULED_TASK_PROMPT_MAX_LENGTH } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { ServerMaintenance } from "./server-maintenance";
import { ScheduledTaskError } from "./errors";
import { assertWindowsDatabaseOffline } from "./windows-database-offline";
import { migrateScheduledTasks, SCHEDULED_TASK_SCHEMA_VERSION } from "./storage/migrations";

type Row = { id: string; revision: number; payload_json: string };

/** Independent of the unavailable legacy worker. Applying requires all old database owners stopped. */
export class ScheduledTaskMigration {
  private applying = false;
  readonly maintenance = new ServerMaintenance(async () => {}, () => this.applying ? [{ runId: "context-migration", reason: "scheduled database migration" }] : [], () => {});

  constructor(readonly databasePath: string, private readonly manager: TerminalSessionManager) {}

  preview(): ScheduledTaskMigrationPreview {
    if (!existsSync(this.databasePath)) return { state: "current", schemaVersion: 0, targetContextVersion: 2, databaseDigest: "", tasks: [] };
    const database = new Database(this.databasePath, { readonly: true });
    try {
      return database.transaction(() => this.readPreview(database))();
    } finally { database.close(); }
  }

  async apply(input: ApplyScheduledTaskMigrationRequest, key: string): Promise<ScheduledTaskMigrationReceipt> {
    if (this.applying) throw failure("migration_busy", "另一项迁移正在进行。");
    const lease = await this.maintenance.acquire(`migration-${key}`);
    this.applying = true;
    let leaseFailure = false;
    const renewal = setInterval(() => {
      try { this.maintenance.renew(`migration-${key}`, lease.leaseId); }
      catch { leaseFailure = true; }
    }, 30000);
    renewal.unref();
    let database: Database.Database | undefined;
    try {
      if (!existsSync(this.databasePath)) throw failure("migration_conflict", "当前实例没有旧任务库。");
      const replay = this.readReceipt(input, key);
      if (replay) return replay;
      this.assertOffline();
      database = new Database(this.databasePath);
      database.pragma("busy_timeout = 5000");
      const preview = database.transaction(() => this.readPreview(database!))();
      this.assertApplicable(database, preview, input);
      const backupPath = path.join(path.dirname(this.databasePath), "migration-backups", `${randomUUID()}.sqlite`);
      mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await database.backup(backupPath);
      chmodSync(backupPath, 0o600);
      const receipt: ScheduledTaskMigrationReceipt = {
        migrationId: randomUUID(), sourceVersion: preview.schemaVersion,
        targetVersion: SCHEDULED_TASK_SCHEMA_VERSION, changedTaskIds: preview.tasks.map(task => task.id),
        backupPath, completedAt: new Date().toISOString(), restartRequired: true,
      };
      database.transaction(() => {
        if (leaseFailure || !this.maintenance.paused) throw failure("migration_busy", "迁移维护租约已失效，未应用数据转换。");
        this.assertApplicable(database!, this.readPreview(database!), input);
        migrateScheduledTasks(database!, new Map(input.tasks.map(task => [task.id, task.prompt])));
        database!.prepare("INSERT INTO scheduled_context_migration_receipts VALUES (?, ?, ?)")
          .run(key, digest(input), JSON.stringify(receipt));
      }).immediate();
      return receipt;
    } finally {
      clearInterval(renewal);
      database?.close();
      this.applying = false;
      if (this.maintenance.paused) this.maintenance.release(`migration-${key}`, lease.leaseId);
    }
  }

  private readPreview(database: Database.Database): ScheduledTaskMigrationPreview {
    const schemaVersion = Number(database.pragma("user_version", { simple: true }));
    if (schemaVersion > SCHEDULED_TASK_SCHEMA_VERSION) throw failure("migration_conflict", "任务库来自更高版本。");
    if (schemaVersion >= 5) return { state: "current", schemaVersion, targetContextVersion: 2, databaseDigest: "", tasks: [] };
    const tasks = database.prepare("SELECT * FROM scheduled_tasks ORDER BY id").all() as Row[];
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scheduled_%' ORDER BY name").all() as { name: string }[];
    const records = tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
    return {
      state: "migration_required", schemaVersion, targetContextVersion: 2, databaseDigest: digest({ schemaVersion, records }),
      tasks: tasks.map(row => {
        const task = JSON.parse(row.payload_json) as Record<string, unknown>;
        const id = typeof task.projectId === "string" ? task.projectId : null;
        const project = id ? this.manager.getProject(id) : undefined;
        const originalPrompt = String(task.prompt);
        const quick = (task.origin as { kind?: string } | undefined)?.kind === "quick-input";
        const suggestedPrompt = `${originalPrompt}\n\n[项目绑定迁移说明]\n原任务从${project?.path ? `目录 ${project.path}` : "未能解析的项目目录"}启动。新任务从独立运行目录启动；需要操作原目标时，先核对路径并读取相应项目规则。此说明不保证原相对路径或执行权限自动保持等价。`;
        const promptFits = suggestedPrompt.length <= SCHEDULED_TASK_PROMPT_MAX_LENGTH;
        return {
          id: row.id, revision: row.revision, originalPrompt,
          prompt: quick || !promptFits ? originalPrompt : suggestedPrompt,
          promptWarning: !quick && !promptFits ? "原文加迁移说明将超过 12000 字符；草稿逐字保留原文，未追加说明。新运行从独立目录启动，请结合原项目路径核对并修改描述后再启用。" : null,
          originalProject: { id, name: project?.name ?? null, path: project?.path ?? null },
          enabled: task.enabled === true, deletedAt: typeof task.deletedAt === "string" ? task.deletedAt : null,
          action: quick ? "convert-quick-origin" : task.deletedAt ? "preserve-deleted" : "pause-and-convert",
        };
      }),
    };
  }

  private assertApplicable(database: Database.Database, preview: ScheduledTaskMigrationPreview, input: ApplyScheduledTaskMigrationRequest): void {
    if (preview.state !== "migration_required" || preview.databaseDigest !== input.expectedDatabaseDigest)
      throw failure("migration_conflict", "任务库已变化，请重新生成并核对迁移预览。");
    const normal = preview.tasks.filter(task => task.action !== "convert-quick-origin");
    if (input.tasks.length !== normal.length || new Set(input.tasks.map(task => task.id)).size !== normal.length ||
        normal.some(task => !input.tasks.some(candidate => candidate.id === task.id && candidate.expectedRevision === task.revision && candidate.prompt.startsWith(task.originalPrompt))))
      throw failure("migration_conflict", "迁移草稿的任务清单或版本不匹配。");
    if (database.prepare("SELECT 1 FROM scheduled_runs WHERE status IN ('queued','running','stopping','waiting') OR owner_pid IS NOT NULL OR json_extract(payload_json, '$.terminalBinding.attachmentState') IN ('creating','starting') LIMIT 1").get())
      throw failure("migration_busy", "仍有未结束运行或终端准备；请先在旧版本中处理，不会自动停止或丢弃。");
  }

  private readReceipt(input: ApplyScheduledTaskMigrationRequest, key: string): ScheduledTaskMigrationReceipt | null {
    const database = new Database(this.databasePath, { readonly: true });
    try {
      if (Number(database.pragma("user_version", { simple: true })) < 5) return null;
      const row = database.prepare("SELECT request_hash, payload_json FROM scheduled_context_migration_receipts WHERE idempotency_key = ?").get(key) as { request_hash: string; payload_json: string } | undefined;
      if (!row) throw failure("migration_conflict", "任务库已迁移，不能建立第二项迁移。");
      if (row.request_hash !== digest(input)) throw failure("idempotency_conflict", "迁移幂等键对应其他请求。");
      return JSON.parse(row.payload_json) as ScheduledTaskMigrationReceipt;
    } finally { database.close(); }
  }

  private assertOffline(): void {
    if (process.platform === "win32") {
      try { assertWindowsDatabaseOffline(this.databasePath); }
      catch { throw failure("migration_busy", "无法独占打开任务数据库或 WAL/SHM；请停止旧任务服务，并确认 PowerShell 可用后重试。"); }
      return;
    }
    let output: string;
    try {
      output = execFileSync(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-t", "--", this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1) throw failure("migration_busy", "无法确认旧数据库 owner 已停止；需要可用的 lsof。");
      output = String(result.stdout ?? "");
    }
    if (output.trim()) throw failure("migration_busy", "数据库仍有打开的连接，请停止旧任务服务后重试。");
  }
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function failure(code: string, message: string): ScheduledTaskError { return new ScheduledTaskError(code, 409, message); }
