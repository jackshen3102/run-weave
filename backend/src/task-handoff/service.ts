import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TaskHandoffCard,
  TaskHandoffResponse,
  TaskHandoffTarget,
} from "@runweave/shared/task-handoff";
import type { ActivityStore } from "../activity/recording/store";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveReplyThread } from "../terminal/completion/reply-preview";
import type { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { TaskHandoffAnalysis } from "./analysis";
import { readHandoffSource } from "./source";

type Entry = {
  card: TaskHandoffCard | null;
  error?: string;
  job?: Promise<void>;
  analyzing?: boolean;
  checkingChanges?: boolean;
  checkedAt: number;
  requestedRevision: number;
};
export class TaskHandoffService {
  private readonly entries = new Map<string, Promise<Entry>>();
  private readonly enabled = new Map<string, TaskHandoffTarget>();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private readonly analysis: TaskHandoffAnalysis;

  constructor(
    private readonly directory: string,
    private readonly manager: TerminalSessionManager,
    private readonly history: AppServerHistoryGateway,
    private readonly activity: ActivityStore | null,
    analysis?: TaskHandoffAnalysis,
  ) {
    this.analysis =
      analysis ?? new TaskHandoffAnalysis(path.join(directory, "analysis"));
    this.timer = setInterval(() => {
      for (const target of this.enabled.values()) {
        void this.get(target.terminalSessionId, target.panelId).catch(
          () => undefined,
        );
      }
    }, 30_000);
    this.timer.unref();
  }

  private key(target: TaskHandoffTarget): string {
    return createHash("sha256").update(JSON.stringify(target)).digest("hex");
  }

  resolve(terminalSessionId: string, panelId?: string | null) {
    const session = this.manager.getSession(terminalSessionId);
    if (!session) throw new Error("终端不存在。");
    const resolvedPanelId =
      panelId ??
      this.manager.getPanelWorkspace(terminalSessionId)?.activePanelId ??
      null;
    const panel = resolvedPanelId
      ? this.manager.getPanel(resolvedPanelId)
      : null;
    if (
      resolvedPanelId &&
      (!panel || panel.terminalSessionId !== terminalSessionId)
    )
      throw new Error("终端面板不存在。");
    const owner = panel ?? session;
    const activeIdentity = resolveReplyThread(owner);
    const identity =
      activeIdentity ??
      (owner.lastThreadId && owner.lastThreadProvider === "codex"
        ? { id: owner.lastThreadId, provider: "codex" }
        : null);
    const target =
      identity?.provider === "codex" && !panel?.agentTeamRunId
        ? { terminalSessionId, panelId: resolvedPanelId, threadId: identity.id }
        : null;
    return {
      target,
      revision: session.completionRevision,
      running:
        owner.terminalState?.state === "agent_running" ||
        owner.terminalState?.state === "agent_starting",
      canContinue:
        session.status === "running" &&
        owner.terminalState?.state === "agent_idle" &&
        activeIdentity?.provider === "codex",
    };
  }

  private entry(target: TaskHandoffTarget): Promise<Entry> {
    const key = this.key(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = (async () => {
        let card: TaskHandoffCard | null = null;
        try {
          const saved = JSON.parse(
            await readFile(path.join(this.directory, `${key}.json`), "utf8"),
          ) as TaskHandoffCard;
          if (
            JSON.stringify(saved.target) !== JSON.stringify(target) ||
            !Array.isArray(saved.turnIds) ||
            !Array.isArray(saved.evidence)
          )
            throw new Error("交接记录格式不正确。");
          card = saved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return { card, checkedAt: 0, requestedRevision: -1 };
      })();
      this.entries.set(key, entry);
      void entry.catch(() => this.entries.delete(key));
    }
    return entry;
  }

  async get(
    terminalSessionId: string,
    panelId?: string | null,
    refresh = false,
  ): Promise<TaskHandoffResponse> {
    const { target, running, revision, canContinue } = this.resolve(
      terminalSessionId,
      panelId,
    );
    if (!target)
      return {
        target: null,
        status: "unsupported",
        card: null,
        message: "任务交接目前支持普通 Codex 会话。",
      };
    const entry = await this.entry(target);
    this.enabled.set(this.key(target), target);
    if (this.enabled.size > 128)
      this.enabled.delete(this.enabled.keys().next().value!);
    if (
      !running &&
      !entry.job &&
      !this.controller.signal.aborted &&
      (refresh ||
        ((!entry.error || entry.requestedRevision !== revision) &&
          (entry.requestedRevision !== revision ||
            Date.now() - entry.checkedAt > 60_000)))
    ) {
      entry.checkingChanges = refresh || entry.requestedRevision !== revision;
      entry.checkedAt = Date.now();
      entry.requestedRevision = revision;
      entry.error = undefined;
      // A single queue bounds provider concurrency across terminals.
      const job = this.queue.then(() => this.update(target, entry));
      entry.job = job.finally(() => {
        entry.analyzing = false;
        entry.job = undefined;
      });
      this.queue = entry.job.catch(() => undefined);
    }
    return {
      target,
      canContinue: canContinue && !entry.job && !entry.error,
      card: entry.card,
      status: running
        ? "running"
        : entry.job &&
            (entry.analyzing ||
              entry.checkingChanges ||
              !entry.card ||
              entry.requestedRevision !== revision)
          ? "updating"
          : entry.error
            ? "error"
            : entry.card
              ? "ready"
              : "empty",
      ...(entry.error ? { message: entry.error } : {}),
    };
  }

  async completed(
    terminalSessionId: string,
    panelId: string | null,
  ): Promise<void> {
    if (this.controller.signal.aborted) return;
    const targets = [...this.enabled.values()].filter(
      (target) =>
        target.terminalSessionId === terminalSessionId &&
        target.panelId === panelId,
    );
    for (const target of targets)
      await this.get(target.terminalSessionId, target.panelId, true).catch(
        () => undefined,
      );
  }

  private async save(card: TaskHandoffCard): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${this.key(card.target)}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(card), { mode: 0o600 });
    await rename(temporary, filename);
  }

  private async update(target: TaskHandoffTarget, entry: Entry): Promise<void> {
    try {
      for (
        let batch = 0;
        batch < 20 && !this.controller.signal.aborted;
        batch++
      ) {
        const current = this.resolve(target.terminalSessionId, target.panelId);
        if (current.running || current.target?.threadId !== target.threadId)
          return;
        const response = await this.history.getThreadDetail(target.threadId);
        if (
          response.availability !== "available" ||
          response.detail?.provider !== "codex" ||
          !("threadId" in response.detail) ||
          response.thread.agent !== "codex" ||
          response.thread.terminalSessionId !== target.terminalSessionId ||
          response.thread.terminalPanelId !== target.panelId
        )
          throw new Error(
            "原生会话记录暂不可用或归属不匹配，旧交接记录已保留。",
          );
        if (response.detail.turns.some((turn) => turn.status === "inProgress"))
          return;
        const previous = entry.card;
        const source = await readHandoffSource(
          target,
          response.detail,
          previous,
          this.activity,
        );
        if (!source.changed) return;
        entry.analyzing = true;
        const summary = await this.analysis.run(
          previous,
          source.evidence,
          this.controller.signal,
        );
        if (this.controller.signal.aborted) return;
        const latest = this.resolve(target.terminalSessionId, target.panelId);
        if (
          latest.running ||
          latest.target?.threadId !== target.threadId ||
          latest.revision !== current.revision
        )
          return;
        const evidenceIds = new Set(
          summary.results.flatMap((item) => item.evidenceIds),
        );
        const keepManualGoal = Boolean(
          previous?.goalEdited &&
          (summary.goal === previous.goal ||
            !source.evidence.some(
              (entry) =>
                entry.kind === "user" &&
                Date.parse(entry.occurredAt) >
                  Date.parse(previous.goalEditedAt ?? previous.updatedAt),
            )),
        );
        const card: TaskHandoffCard = {
          ...summary,
          target,
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
          goal: keepManualGoal ? previous!.goal : summary.goal,
          goalEdited: keepManualGoal,
          ...(previous?.goalEditedAt
            ? { goalEditedAt: previous.goalEditedAt }
            : {}),
          evidence: source.evidence.filter((item) => evidenceIds.has(item.id)),
          limitations: [
            ...new Set([
              ...(previous?.limitations ?? []),
              ...source.limitations,
            ]),
          ],
          turnIds: source.turnIds,
        };
        await this.save(card);
        entry.card = card;
        if (!source.more) return;
      }
      if (!this.controller.signal.aborted)
        entry.error = "历史尚未整理完，请点击刷新继续。";
    } catch (error) {
      if (!this.controller.signal.aborted)
        entry.error =
          error instanceof Error
            ? error.message.slice(0, 300)
            : "整理失败，旧交接记录已保留。";
    }
  }

  async edit(
    target: TaskHandoffTarget,
    revision: number,
    goal: string,
  ): Promise<TaskHandoffCard> {
    const current = this.resolve(target.terminalSessionId, target.panelId);
    if (current.target?.threadId !== target.threadId)
      throw new Error("会话已切换，请刷新后重试。");
    const entry = await this.entry(target);
    if (entry.job) throw new Error("正在整理，请完成后再编辑。");
    if (!entry.card || entry.card.revision !== revision)
      throw new Error("交接记录已更新，请刷新后再编辑。");
    // Publish the revision before I/O so simultaneous editors cannot both win.
    const previous = entry.card;
    const card = {
      ...previous,
      goal,
      goalEdited: true,
      goalEditedAt: new Date().toISOString(),
      results: [],
      pending: [],
      nextStep: "",
      turnIds: [],
      limitations: [],
      revision: revision + 1,
      updatedAt: new Date().toISOString(),
    };
    entry.card = card;
    const saving = this.save(card);
    entry.job = saving;
    try {
      await saving;
      entry.checkedAt = 0;
      entry.error = undefined;
      return card;
    } catch (error) {
      entry.card = previous;
      throw error;
    } finally {
      entry.job = undefined;
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.queue;
    await Promise.allSettled(
      (await Promise.allSettled(this.entries.values())).flatMap((result) =>
        result.status === "fulfilled" && result.value.job
          ? [result.value.job]
          : [],
      ),
    );
  }
}
