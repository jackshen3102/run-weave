import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { journalSchema } from "./journal-schema";
import {
  supervisionDecisionSummary,
  supervisionGoalPreview,
  type SupervisionDecision,
  type SupervisionDecisionSummary,
  type SupervisionDecisionDetail,
  type SupervisionDecisionPage,
  type TaskWatch,
  type SupervisionGoalDetail,
  type SupervisionGoalPage,
} from "@runweave/shared/task-supervision";

export type ArchiveChange = {
  watchId: string;
  decision: SupervisionDecision | SupervisionDecisionSummary;
} | { watchId: string; goal: SupervisionGoalDetail } | { watchId: string; goalApplicationId: string }
  | { watchId: string; remove: true };

export interface SupervisionJournal {
  version: 1;
  watches: TaskWatch[];
  /** Only receipts created in the current transaction; older receipts stay indexed on disk. */
  requests: Record<string, { digest: string; watchId: string }>;
}
export function findTerminalWatch(
  journal: SupervisionJournal,
  terminalSessionId: string,
) {
  return [...journal.watches]
    .reverse()
    .find(
      (watch) =>
        watch.target.terminalSessionId === terminalSessionId &&
        watch.pauseReason !== "replaced",
    );
}
/** Retain source identities, never historical bodies, in the scheduler's working set. */
export function compactWatch(watch: TaskWatch) {
  watch.task = { ...watch.task, text: supervisionGoalPreview(watch.task.text) };
  watch.goal = supervisionGoalPreview(watch.goal);
  watch.plans = watch.plans.map((plan) => ({ ...plan, text: "" }));
  watch.decisions = watch.decisions
    .filter((d) => d.threadId === watch.target.threadId)
    .slice(-1);
  if (Buffer.byteLength(JSON.stringify(watch)) > 64 * 1024)
    throw new Error("活跃监控状态超出 64 KiB；未提交本次状态。");
}

export class TaskSupervisionStore {
  private db?: Database.Database;
  constructor(private readonly directory: string) {}
  private database() {
    if (!this.db) throw new Error("监控存储未打开。");
    return this.db;
  }
  async load(): Promise<SupervisionJournal> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "supervision.sqlite");
    const db = new Database(file);
    this.db = db;
    try {
      await chmod(file, 0o600);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma("busy_timeout = 5000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, watch_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, reply_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          summary TEXT NOT NULL, input TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS decisions_page ON decisions(watch_id, seq DESC);
        CREATE INDEX IF NOT EXISTS decisions_thread_page ON decisions(watch_id, thread_id, seq DESC);
        CREATE INDEX IF NOT EXISTS decisions_reply ON decisions(watch_id, thread_id, reply_id, turn_id);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, watch_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS goal_revisions (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS goal_revisions_watch ON goal_revisions(watch_id);
        CREATE TABLE IF NOT EXISTS goal_applications (id TEXT PRIMARY KEY, watch_id TEXT NOT NULL);
      `);
      db.transaction(() => {
        const columns = db.pragma("table_info(decisions)") as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "assessment"))
          db.exec("ALTER TABLE decisions ADD COLUMN assessment TEXT");
      })();
      if (
        !db
          .prepare("SELECT value FROM metadata WHERE key = 'initialized'")
          .get()
      ) {
        let bytes: string | null = null;
        try {
          bytes = await readFile(
            path.join(this.directory, "watches.json"),
            "utf8",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const legacy = bytes ? journalSchema.parse(JSON.parse(bytes)) : null;
        const hash = createHash("sha256")
          .update(bytes ?? "")
          .digest("hex");
        if (bytes) {
          const backup = path.join(this.directory, `watches.v1.${hash}.json`);
          try {
            await writeFile(backup, bytes, { mode: 0o600, flag: "wx" });
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              (await readFile(backup, "utf8")) !== bytes
            )
              throw error;
          }
        }
        db.transaction(() => {
          for (const old of legacy?.watches ?? []) {
            for (const decision of old.decisions) {
              this.insertDecision(old.watchId, decision);
              const imported = this.detail(old.watchId, decision.decisionId)!;
              if (
                JSON.stringify(imported.input) !==
                  JSON.stringify(decision.input) ||
                JSON.stringify(supervisionDecisionSummary(imported)) !==
                  JSON.stringify(supervisionDecisionSummary(decision))
              )
                throw new Error("监控历史迁移内容不一致，已回滚。");
            }
            const current = old.decisions.filter(
              (d) => d.threadId === old.target.threadId,
            );
            const watch: TaskWatch = {
              ...old,
              decisions: current.slice(-1).map(supervisionDecisionSummary),
              completedReplyIds: [
                ...new Set(
                  current
                    .filter((d) => d.outcome === "completed")
                    .map((d) => d.input.currentReply.id),
                ),
              ],
              observedContinuationCount: current.filter(
                (d) =>
                  d.contextRevision === old.contextRevision &&
                  d.delivery === "observed",
              ).length,
              evidenceMessageIds: [
                ...new Set(
                  current
                    .slice(-3)
                    .flatMap((d) => [
                      d.input.task.id,
                      ...d.sourceMessageIds,
                      d.input.currentReply.id,
                    ]),
                ),
              ],
              ...(old.goal && old.goal !== old.task.text
                ? { goalOverride: old.goal }
                : {}),
            };
            compactWatch(watch);
            db.prepare("INSERT INTO watches VALUES (?, ?)").run(
              watch.watchId,
              JSON.stringify(watch),
            );
          }
          for (const [id, receipt] of Object.entries(legacy?.requests ?? {}))
            db.prepare("INSERT INTO receipts VALUES (?, ?, ?)").run(
              id,
              receipt.digest,
              receipt.watchId,
            );
          const expected =
            legacy?.watches.reduce(
              (count, watch) => count + watch.decisions.length,
              0,
            ) ?? 0;
          const actual = (
            db.prepare("SELECT count(*) AS count FROM decisions").get() as {
              count: number;
            }
          ).count;
          if (actual !== expected)
            throw new Error("监控历史迁移数量不一致，已回滚。");
          db.prepare("INSERT INTO metadata VALUES ('initialized', ?)").run(
            hash,
          );
        })();
      }
      const watches = (
        db.prepare("SELECT body FROM watches ORDER BY rowid").all() as {
          body: string;
        }[]
      ).map(({ body }) => JSON.parse(body) as TaskWatch);
      for (const watch of watches) {
        if (watch.status === "classifying") {
          watch.status = "error";
          watch.error = "监听服务已重启，旧分类已取消；等待有效回复。";
        }
        for (const decision of watch.decisions) {
          if (decision.delivery === "offered") {
            decision.delivery = "unknown";
            if (decision.contextRevision === watch.contextRevision) {
              watch.status = "paused";
              watch.pauseReason = "delivery_unknown";
            }
          }
        }
      }
      // Disabled records from older versions also follow the close-and-clear contract.
      const journal: SupervisionJournal = { version: 1, watches: watches.filter((watch) => watch.enabled), requests: {} };
      await this.save(journal, watches.filter((watch) => !watch.enabled).map((watch) => ({ watchId: watch.watchId, remove: true })));
      return journal;
    } catch (error) {
      db.close();
      this.db = undefined;
      throw error;
    }
  }
  private insertDecision(watchId: string, decision: SupervisionDecision) {
    this.database()
      .prepare(
        `INSERT INTO decisions(id, watch_id, thread_id, reply_id, turn_id, summary, input, assessment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.decisionId,
        watchId,
        decision.threadId ?? "",
        decision.input.currentReply.id,
        decision.rawTurnId,
        JSON.stringify(supervisionDecisionSummary(decision)),
        JSON.stringify(decision.input),
        decision.assessment ? JSON.stringify(decision.assessment) : null,
      );
  }
  async save(journal: SupervisionJournal, additions: ArchiveChange[] = []) {
    const db = this.database();
    db.transaction(() => {
      for (const change of additions) {
        if ("remove" in change) {
          for (const table of ["decisions", "goal_revisions", "goal_applications"])
            db.prepare(`DELETE FROM ${table} WHERE watch_id=?`).run(change.watchId);
          db.prepare("DELETE FROM watches WHERE id=?").run(change.watchId);
          // Keep request digests as tombstones: a delayed start retry must not revive a deleted watch.
          continue;
        }
        if ("goalApplicationId" in change) { db.prepare("INSERT INTO goal_applications(id, watch_id) VALUES (?, ?)").run(change.goalApplicationId, change.watchId); continue; }
        if ("goal" in change) {
          db.prepare("INSERT INTO goal_revisions(id, watch_id, body) VALUES (?, ?, ?)").run(change.goal.goal.revisionId, change.watchId, JSON.stringify(change.goal));
          continue;
        }
        const { watchId, decision } = change;
        if ("input" in decision) this.insertDecision(watchId, decision);
        else
          db.prepare(
            "UPDATE decisions SET summary=? WHERE id=? AND watch_id=?",
          ).run(JSON.stringify(decision), decision.decisionId, watchId);
      }
      for (const watch of journal.watches) {
        compactWatch(watch);
        const body = JSON.stringify(watch);
        db.prepare(
          "INSERT INTO watches VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body != excluded.body",
        ).run(watch.watchId, body);
        for (const decision of watch.decisions)
          db.prepare(
            "UPDATE decisions SET summary=? WHERE id=? AND watch_id=? AND summary != ?",
          ).run(
            JSON.stringify(decision),
            decision.decisionId,
            watch.watchId,
            JSON.stringify(decision),
          );
      }
      for (const [id, receipt] of Object.entries(journal.requests))
        db.prepare("INSERT INTO receipts VALUES (?, ?, ?)").run(
          id,
          receipt.digest,
          receipt.watchId,
        );
    })();
    journal.requests = {};
  }
  receipt(id: string) {
    const row = this.database()
      .prepare("SELECT digest, watch_id AS watchId FROM receipts WHERE id=?")
      .get(id);
    return row as { digest: string; watchId: string } | undefined;
  }
  processed(
    watchId: string,
    threadId: string,
    replyId: string,
    turnId: string,
    goalVersion?: number,
    contextRevision?: number,
  ) {
    return Boolean(
      this.database()
        .prepare(
          "SELECT 1 FROM decisions WHERE watch_id=? AND thread_id=? AND reply_id=? AND turn_id=? AND (? IS NULL OR json_extract(summary, '$.goalVersion')=?) AND (? IS NULL OR json_extract(summary, '$.contextRevision')=?) LIMIT 1",
        )
        .get(watchId, threadId, replyId, turnId, goalVersion ?? null, goalVersion ?? null, contextRevision ?? null, contextRevision ?? null),
    );
  }
  goalApplied(watchId: string, previewId: string) { return !!this.database().prepare("SELECT 1 FROM goal_applications WHERE id=? AND watch_id=?").get(previewId, watchId); }
  goals(watchId: string, cursor?: string): SupervisionGoalPage {
    const rows = this.database().prepare("SELECT rowid AS seq, json_extract(body, '$.goal') AS goal, json_extract(body, '$.reason') AS reason FROM goal_revisions WHERE watch_id=? AND rowid < ? ORDER BY rowid DESC LIMIT 11").all(watchId, cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER) as Array<{ seq: number; goal: string; reason: string }>;
    return { goals: rows.slice(0, 10).map((row) => ({ goal: JSON.parse(row.goal), reason: row.reason })), nextCursor: rows.length > 10 ? String(rows[9]!.seq) : null };
  }
  goalDetail(watchId: string, revisionId: string): SupervisionGoalDetail | null {
    const row = this.database().prepare("SELECT body FROM goal_revisions WHERE watch_id=? AND id=?").get(watchId, revisionId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  detail(watchId: string, id: string): SupervisionDecisionDetail | null {
    const row = this.database()
      .prepare("SELECT summary, input, assessment FROM decisions WHERE watch_id=? AND id=?")
      .get(watchId, id) as { summary: string; input: string; assessment: string | null } | undefined;
    return row
      ? { ...JSON.parse(row.summary), input: JSON.parse(row.input), ...(row.assessment ? { assessment: JSON.parse(row.assessment) } : {}) }
      : null;
  }
  summary(watchId: string, id: string): SupervisionDecisionSummary | undefined {
    const row = this.database()
      .prepare("SELECT summary FROM decisions WHERE watch_id=? AND id=?")
      .get(watchId, id) as { summary: string } | undefined;
    return row ? JSON.parse(row.summary) : undefined;
  }
  page(watchId: string, cursor?: string, limit = 20): SupervisionDecisionPage {
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1)
      throw new Error("无效历史游标。");
    const rows = this.database()
      .prepare(
        "SELECT seq, summary FROM decisions WHERE watch_id=? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(watchId, before, limit + 1) as { seq: number; summary: string }[];
    const decisions: SupervisionDecisionPage["decisions"] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const next = Buffer.byteLength(row.summary);
      if (bytes + next > 60 * 1024 && decisions.length) break;
      decisions.push(JSON.parse(row.summary));
      bytes += next;
    }
    return {
      decisions,
      nextCursor:
        rows.length > decisions.length
          ? String(rows[decisions.length - 1]!.seq)
          : null,
    };
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}
