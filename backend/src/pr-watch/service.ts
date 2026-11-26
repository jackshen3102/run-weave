import { randomUUID } from "node:crypto";
import type {
  ChangePrWatchRequest,
  PrWatchResponse,
  StartPrWatchRequest,
  TerminalPrWatchPauseReason,
} from "@runweave/shared/pr-watch";
import type { SupervisionTarget } from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { TerminalEventService } from "../terminal/state/terminal-event-service";
import {
  clearTerminalDraft,
  hasPendingTerminalInput,
  terminalInputAdmission,
} from "../terminal/runtime/input-admission";
import { getTerminalSessionAgent } from "../terminal/state/terminal-state-service";
import { readCodexContext } from "../terminal/runtime/codex-context";
import { SupervisionError } from "../task-supervision/errors";
import { resolveSupervisionTarget } from "../task-supervision/target";
import { logger } from "../logging/index";
import { combine, evaluate, prompt } from "./evaluator";
import { findPr, readPr, validatePrUrl } from "./gh-reader";
import { PrWatchStore, type WatchRecord } from "./store";

export type DeliverPrompt = (
  target: SupervisionTarget,
  text: string,
  operationId: string,
  valid: () => void,
) => Promise<void>;
const now = () => new Date().toISOString();
const changed = () =>
  new SupervisionError("值守、输入或终端已变化，请刷新后重试。");
export class PrWatchService {
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private closed = false;
  private queue = new Set<string>();
  private polling = new Map<string, Promise<void>>();
  private requests = new Set<Promise<unknown>>();
  private starting = new Map<string, object>();
  // A surviving pane can retain an unsent draft across Backend restarts.
  private restored = new Set<string>();
  constructor(
    private store: PrWatchStore,
    private manager: TerminalSessionManager,
    private deliver: DeliverPrompt,
  ) {}

  start(events: TerminalEventService) {
    if (this.timer) return;
    for (const r of this.store.all()) this.restored.add(r.state.watchId);
    this.timer = setInterval(() => this.schedule(), 120_000);
    this.timer.unref();
    this.unsubscribe = events.subscribe((event) => {
      if (
        event.kind === "terminal_state_changed" ||
        event.kind === "completion"
      ) {
        const id = event.terminalSessionId;
        const r = this.store.get(id);
        if (r?.pending && r.state.status === "watching") {
          this.queue.add(id);
          this.drain();
        }
      }
    });
  }
  schedule() {
    for (const { state } of this.store.all()) {
      if (
        this.manager.getSession(state.terminalSessionId)?.status !== "running"
      )
        this.remove(state.terminalSessionId);
      else if (state.status === "watching")
        this.queue.add(state.terminalSessionId);
    }
    this.drain();
  }
  private drain() {
    for (const id of this.queue) {
      if (this.closed || this.polling.size >= 4) break;
      if (this.polling.has(id)) continue;
      this.queue.delete(id);
      const work = this.poll(id)
        .catch((error) =>
          logger.error("pr-watch.poll.failed", {
            terminalSessionId: id,
            error,
          }),
        )
        .finally(() => {
          this.polling.delete(id);
          this.drain();
        });
      this.polling.set(id, work);
    }
  }
  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.queue.clear();
    await Promise.allSettled([...this.polling.values(), ...this.requests]);
    this.store.close();
  }
  track<T>(work: Promise<T>) {
    this.requests.add(work);
    return work.finally(() => this.requests.delete(work));
  }
  get(id: string) {
    return this.store.get(id)?.state ?? null;
  }
  private session(id: string) {
    const s = this.manager.getSession(id);
    if (!s) throw new SupervisionError("未找到终端。", 404);
    return s;
  }
  async inspect(id: string, detect: boolean): Promise<PrWatchResponse> {
    const s = this.session(id);
    const r = this.store.get(id);
    if (r?.state.pauseReason === "draft_unconfirmed") {
      const version = terminalInputAdmission(s).inputVersion;
      if (version !== r.inputVersion) {
        r.inputVersion = version;
        this.save(r);
      }
      return { watch: r.state, inputVersion: version };
    }
    return {
      watch: r?.state ?? null,
      ...(!r && detect ? { candidatePr: await findPr(s.cwd, {}) } : {}),
    };
  }
  private save(r: WatchRecord) {
    r.state.revision++;
    this.store.save(r);
  }
  private pause(
    r: WatchRecord,
    reason: TerminalPrWatchPauseReason,
    summary: string,
  ) {
    Object.assign(r.state, {
      status: "paused",
      pauseReason: reason,
      lastSummary: summary,
    });
    this.save(r);
  }
  remove(id: string) {
    if (this.closed) return;
    this.starting.delete(id);
    this.queue.delete(id);
    const record = this.store.get(id);
    if (record) this.restored.delete(record.state.watchId);
    this.store.delete(id);
  }
  async bind(id: string, req: StartPrWatchRequest) {
    const previous = this.store.get(id);
    if (
      previous?.operationId === req.operationId &&
      (!req.prNumber || req.prNumber === previous.state.prNumber) &&
      (!req.prUrl || req.prUrl === previous.state.prUrl)
    )
      return previous.state;
    if (previous || this.starting.has(id)) {
      if (req.prUrl) await validatePrUrl(this.session(id).cwd, req.prUrl);
      throw changed();
    }
    const token = {};
    this.starting.set(id, token);
    try {
      const panelId = this.manager.getPanelWorkspace(id)?.activePanelId;
      const { target, owner, session } = resolveSupervisionTarget(
        this.manager,
        id,
        panelId,
      );
      const provider = getTerminalSessionAgent(owner);
      const cwd = session.cwd;
      const pr = await findPr(cwd, req);
      if (!pr) throw new SupervisionError("请选择打开的 PR。", 422);
      const snap = await readPr(cwd, pr);
      if (snap.state !== "OPEN") throw new SupervisionError("PR 已结束。", 422);
      const record: WatchRecord = {
        state: {
          ...pr,
          watchId: randomUUID(),
          terminalSessionId: id,
          panelId: target.panelId,
          threadId: target.threadId || null,
          threadProvider: provider,
          status: "watching",
          pauseReason: null,
          headSha: snap.head,
          commentWakeCount: 0,
          consecutiveReadFailures: 0,
          lastCheckedAt: now(),
          lastWakeAt: null,
          lastSummary: null,
          revision: 1,
        },
        operationId: req.operationId,
        generation: target.executorGeneration,
        baseline: evaluate(snap).baseline,
        pending: null,
      };
      this.target(record);
      if (
        this.closed ||
        this.starting.get(id) !== token ||
        this.session(id).cwd !== cwd
      )
        throw changed();
      this.store.save(record);
      return record.state;
    } finally {
      if (this.starting.get(id) === token) this.starting.delete(id);
    }
  }
  private target(r: WatchRecord) {
    const { state: s } = r;
    const live = resolveSupervisionTarget(
      this.manager,
      s.terminalSessionId,
      s.panelId,
    );
    if (
      live.target.executorGeneration !== r.generation ||
      (live.target.threadId || null) !== s.threadId ||
      getTerminalSessionAgent(live.owner) !== s.threadProvider
    )
      throw changed();
    const observed =
      s.threadProvider === "codex"
        ? readCodexContext({
            terminalSessionId: s.terminalSessionId,
            id: s.panelId,
          })
        : null;
    if (observed?.managed && observed.context?.displayedThreadId !== s.threadId)
      throw changed();
    const idle =
      live.owner.terminalState?.state === "agent_idle" &&
      (!observed?.managed ||
        (!!observed.context?.inputReady && !observed.context.displayedRunning));
    return { ...live, idle };
  }
  private current(r: WatchRecord) {
    const state = this.get(r.state.terminalSessionId);
    return (
      !this.closed &&
      state?.watchId === r.state.watchId &&
      state.revision === r.state.revision
    );
  }
  private async poll(
    id: string,
    confirming?: { revision: number; version: string },
  ) {
    const r = this.store.get(id);
    if (
      !r ||
      (confirming
        ? r.state.revision !== confirming.revision
        : r.state.status !== "watching")
    )
      return;
    const s = r.state;
    const session = this.session(id);
    const cwd = session.cwd;
    let snap;
    try {
      snap = await readPr(cwd, s);
    } catch {
      if (!this.current(r)) return;
      if (confirming)
        throw new SupervisionError("PR 读取失败，请稍后重试。", 422);
      s.lastCheckedAt = now();
      if (++s.consecutiveReadFailures >= 8)
        this.pause(
          r,
          "read_failed_limit",
          "连续 8 次读取失败，请检查 gh 登录和网络。",
        );
      else this.save(r);
      return;
    }
    if (!this.current(r) || this.manager.getSession(id)?.cwd !== cwd) {
      if (confirming) throw changed();
      return;
    }
    s.consecutiveReadFailures = 0;
    s.lastCheckedAt = now();
    s.prTitle = snap.prTitle;
    if (snap.state !== "OPEN") {
      Object.assign(s, {
        status: "settled",
        headSha: snap.head,
        pauseReason: null,
        lastSummary: `PR #${s.prNumber} 已${snap.state === "MERGED" ? "合并" : "关闭"}，值守已结束。`,
      });
      r.pending = null;
      this.save(r);
      return;
    }
    const result = evaluate(snap, r.baseline);
    r.pending = combine(
      s.headSha === snap.head ? r.pending : null,
      result.wake,
    );
    r.baseline = result.baseline;
    s.headSha = snap.head;
    if (result.changed) s.commentWakeCount = 0;
    if (
      confirming &&
      terminalInputAdmission(session).inputVersion !== confirming.version
    )
      throw changed();
    if (!r.pending && confirming) {
      s.status = "watching";
      s.pauseReason = null;
    }
    if (!r.pending) {
      this.save(r);
      return;
    }
    let live;
    try {
      live = this.target(r);
    } catch {
      this.pause(
        r,
        "thread_changed",
        "原面板或 Agent 会话已变化，请重新绑定。",
      );
      return;
    }
    if (!live.idle) {
      if (confirming) throw changed();
      this.save(r);
      return;
    }
    if (r.pending.commentsOnly && s.commentWakeCount >= 10) {
      this.pause(
        r,
        "wake_limit_reached",
        "已连续唤醒 10 次，请检查 PR 再恢复。",
      );
      return;
    }
    const pane = live.panel?.tmuxPaneId ?? null;
    if (confirming) {
      if (pane && terminalInputAdmission(session).pendingUserInput.has(null))
        throw changed();
      clearTerminalDraft(session, pane, "pr-watch-confirmed-empty");
      this.restored.delete(s.watchId);
    } else if (
      hasPendingTerminalInput(session, pane) ||
      this.restored.has(s.watchId)
    ) {
      r.inputVersion = terminalInputAdmission(session).inputVersion;
      this.pause(
        r,
        "draft_unconfirmed",
        "请检查原面板，确认输入框为空后发送。",
      );
      return;
    }
    const wake = r.pending;
    // Reserve before crossing the terminal I/O boundary. Unknown writes never replay after restart.
    r.pending = null;
    s.status = "error";
    s.pauseReason = null;
    s.lastSummary = "投递结果待核实，请检查原面板。";
    this.save(r);
    const valid = () => {
      if (!this.current(r) || !this.target(r).idle) throw changed();
    };
    await this.deliver(
      live.target,
      prompt(s.prUrl, snap.head, wake),
      randomUUID(),
      valid,
    );
    if (!this.current(r)) return;
    s.status = "watching";
    s.lastWakeAt = now();
    s.lastSummary = wake.lines[0] ?? null;
    s.commentWakeCount = wake.commentsOnly ? s.commentWakeCount + 1 : 0;
    this.save(r);
  }
  async change(id: string, req: ChangePrWatchRequest) {
    const r = this.store.get(id);
    if (
      !r ||
      r.state.revision !== req.expectedRevision ||
      r.state.status === "settled"
    )
      throw changed();
    if (req.action === "pause" && r.state.status === "watching")
      this.pause(r, "manual", "已手动暂停。");
    else if (
      req.action === "confirm_empty_draft_and_deliver" &&
      r.state.pauseReason === "draft_unconfirmed"
    ) {
      const version = req.expectedInputVersion ?? r.inputVersion;
      if (
        !version ||
        version !== terminalInputAdmission(this.session(id)).inputVersion
      )
        throw changed();
      await this.poll(id, { revision: req.expectedRevision, version });
    } else if (
      req.action === "resume" &&
      r.state.status === "paused" &&
      r.state.pauseReason !== "draft_unconfirmed"
    ) {
      this.target(r);
      if (r.state.pauseReason === "wake_limit_reached")
        r.state.commentWakeCount = 0;
      Object.assign(r.state, {
        status: "watching",
        pauseReason: null,
        consecutiveReadFailures: 0,
        lastSummary: "已恢复值守。",
      });
      this.save(r);
    } else throw changed();
    return this.get(id);
  }
}
