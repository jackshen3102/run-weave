import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScheduledRun, ScheduledTask } from "@runweave/shared/scheduled-tasks";
import { QuickInputTerminalScheduledTaskProvider, type QuickInputTurnClassifier } from "../../../backend/src/scheduled-tasks/providers/quick-input-terminal";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import { ScheduledTerminalAttachment } from "../../../backend/src/scheduled-tasks/terminal-attachment";
import type { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import { beginTerminalInput } from "../../../backend/src/terminal/runtime/input-admission";
import { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import { PtyService } from "../../../backend/src/terminal/runtime/pty-service";
import { TerminalRuntimeRegistry } from "../../../backend/src/terminal/runtime/registry";
import { TerminalEventService } from "../../../backend/src/terminal/state/terminal-event-service";
import { TerminalStateService } from "../../../backend/src/terminal/state/terminal-state-service";
import { TerminalStateStore } from "../../../backend/src/terminal/state/terminal-state-store";
import { LowDbTerminalSessionStore } from "../../../backend/src/terminal/store/lowdb-store";
import { TmuxService } from "../../../backend/src/terminal/tmux/service";
import type { AppServerHistoryGateway } from "../../../backend/src/work-history/app-server-history-gateway";

export async function verifyQuickInputTerminal(
  store: ScheduledTaskStore,
  taskFixture: () => ScheduledTask,
): Promise<void> {
  const probe = new TmuxService();
  if (!(await probe.isAvailable())) {
    throw new Error("tmux is required for verifyQuickInputTerminal");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "rw-qi-term-"));
  const previousZdotdir = process.env.ZDOTDIR;
  process.env.ZDOTDIR = root;
  const socketPath = path.join(root, "tmux.sock");
  const tmuxService = new TmuxService({ socketPath, sessionPrefix: "rw-qi-verify" });
  const ptyService = new PtyService();
  const runtimeRegistry = new TerminalRuntimeRegistry();
  const terminalEventService = new TerminalEventService();
  const sessionStore = new LowDbTerminalSessionStore(path.join(root, "sessions.json"));
  const manager = new TerminalSessionManager(sessionStore);
  await manager.initialize();
  const project = await manager.createProject("qi-project", root);
  const terminalStateService = new TerminalStateService(
    new TerminalStateStore(),
    terminalEventService,
    (id, state) => {
      void manager.updateSessionTerminalState(id, state);
    },
  );
  const terminalOptions = {
    ptyService,
    runtimeRegistry,
    tmuxService,
    terminalEventService,
    terminalStateService,
  };

  try {
    // 1. Headless quick-input still routes to headless provider (0 terminals created)
    let headlessRuns = 0;
    const headlessTask: ScheduledTask = {
      ...taskFixture(),
      id: randomUUID(),
      enabled: false,
      nextRunAt: null,
      origin: {
        kind: "quick-input",
        quickInputId: randomUUID(),
        projectId: project.id,
        projectName: project.name,
        worktreeName: null,
        backgroundRuntime: "headless",
      },
    };
    const headlessQueued = await store.createQuickInputRun(headlessTask, root, "hl-1", "hl-1");

    // Shared fake conversation state driven when pane starts fake agent (`cat` shell command)
    const threads = new Map<string, {
      provider: "codex";
      threadId: string;
      turns: Array<{
        id: string;
        status: "inProgress" | "completed";
        itemsView: "full";
        messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string; phase?: "final" | "commentary" }>;
      }>;
    }>();
    const history = {
      getThreadDetail: async (threadId: string) => {
        const detail = threads.get(threadId);
        return detail
          ? { availability: "available" as const, detail: { ...detail, turns: [...detail.turns] } }
          : { availability: "missing" as const, detail: null };
      },
    } as unknown as AppServerHistoryGateway;

    let nextVerdictMode: "complete" | "continue-then-complete" | "blocked" | "hold" | "wait-for-takeover" = "complete";
    let continueCount = 0;
    const classifierCalls: string[] = [];
    const classifier: QuickInputTurnClassifier = async (input) => {
      classifierCalls.push(input.goal);
      if (nextVerdictMode === "complete") {
        return {
          outcome: "completed",
          reason: "全部要求已完成",
          guidance: { remainingWork: "", nextAction: "", authorizationMessageIds: [], blocker: "", requiredUserAction: "" },
          assessment: { disposition: "apply" },
        };
      }
      if (nextVerdictMode === "continue-then-complete") {
        continueCount += 1;
        if (continueCount === 1) {
          setTimeout(() => {
            const record = [...threads.values()].at(-1);
            if (record && record.turns.length === 1) {
              record.turns.push({
                id: "turn-2",
                status: "completed",
                itemsView: "full",
                messages: [
                  { id: "u-2", role: "user", text: "[runweave-task-supervision:followup]", createdAt: new Date().toISOString() },
                  { id: "a-2", role: "assistant", text: "第二轮续接已完成全部收尾检查。", createdAt: new Date().toISOString(), phase: "final" },
                ],
              });
            }
          }, 800);
          return {
            outcome: "continue",
            reason: "还需补齐验证步骤",
            guidance: {
              remainingWork: "执行最终检查",
              nextAction: "继续完成最终检查并汇报结果",
              authorizationMessageIds: [input.task.id],
              blocker: "",
              requiredUserAction: "",
            },
            assessment: { disposition: "apply" },
          };
        }
        return {
          outcome: "completed",
          reason: "续接后已完成全部要求",
          guidance: { remainingWork: "", nextAction: "", authorizationMessageIds: [], blocker: "", requiredUserAction: "" },
          assessment: { disposition: "apply" },
        };
      }
      if (nextVerdictMode === "hold") {
        return {
          outcome: "completed",
          reason: "完成条件覆盖不足",
          guidance: { remainingWork: "", nextAction: "", authorizationMessageIds: [], blocker: "", requiredUserAction: "" },
          assessment: { disposition: "hold", holdReason: "evidence_gap" },
        };
      }
      return {
        outcome: "blocked",
        reason: "缺少登录凭证",
        guidance: {
          remainingWork: "完成环境验证",
          nextAction: "",
          authorizationMessageIds: [],
          blocker: "测试环境登录已过期",
          requiredUserAction: "请在保留的终端或浏览器中完成登录",
        },
        assessment: { disposition: "apply" },
      };
    };

    // Use `sleep 30` via shell script wrapper as fake interactive TUI binary so it stays alive until closed/interrupted
    const fakeCodexPath = path.join(root, "fake-codex.sh");
    const argsLogPath = path.join(root, "codex-args.log");
    const { access, writeFile, chmod, readFile } = await import("node:fs/promises");
    await writeFile(
      fakeCodexPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLogPath}"\nexec sleep 60\n`,
      { mode: 0o755 },
    );
    await chmod(fakeCodexPath, 0o755);

    // Drive panel threadId + idle transitions automatically once prepareTerminalAgent finishes staging (`agent_starting`)
    const createdEvents: Array<{ sessionId: string; activate?: boolean }> = [];
    const unsub = terminalEventService.subscribe((event) => {
      if (event.kind === "terminal_session_created") {
        createdEvents.push({
          sessionId: event.terminalSessionId,
          activate: event.payload.activate,
        });
        void (async () => {
          const sessionId = event.terminalSessionId;
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline) {
            const session = manager.getSession(sessionId);
            const panel = manager.listPanels(sessionId)[0];
            if (!session || !panel) return;
            const generation = manager.getPanelAgentOperationGeneration(sessionId, panel.id);
            if (generation && panel.terminalState?.state === "agent_starting") {
              while (Date.now() < deadline) {
                try {
                  await access(argsLogPath);
                  break;
                } catch {
                  await new Promise((r) => setTimeout(r, 50));
                }
              }
              const threadId = `thread-${sessionId}`;
              threads.set(threadId, {
                provider: "codex",
                threadId,
                turns: [{
                  id: "turn-1",
                  status: nextVerdictMode === "wait-for-takeover" ? "inProgress" : "completed",
                  itemsView: "full",
                  messages: [
                    { id: "u-1", role: "user", text: "执行快捷指令", createdAt: new Date().toISOString() },
                    { id: "a-1", role: "assistant", text: "第一轮自然语言执行汇报。", createdAt: new Date().toISOString(), phase: "final" },
                  ],
                }],
              });
              await manager.observePanelActiveCommand(sessionId, panel.id, panel.activeCommand, "codex");
              panel.activeCommand = "codex";
              await manager.upsertPanel(panel);
              await manager.updatePanelThreadId(panel.id, threadId, "codex", generation.operationId);
              if (nextVerdictMode !== "wait-for-takeover") {
                await manager.updatePanelTerminalState(panel.id, { state: "agent_idle", agent: "codex" }, generation.operationId);
              } else {
                await manager.updatePanelTerminalState(panel.id, { state: "agent_running", agent: "codex" }, generation.operationId);
              }
              return;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        })();
      }
      if (event.kind === "terminal_panel_input_sent") {
        const sessionId = event.terminalSessionId;
        const panel = manager.listPanels(sessionId)[0];
        const threadId = panel?.threadId;
        if (panel && threadId && threads.has(threadId) && nextVerdictMode === "continue-then-complete") {
          const record = threads.get(threadId)!;
          if (record.turns.length === 1) {
            record.turns.push({
              id: "turn-2",
              status: "completed",
              itemsView: "full",
              messages: [
                { id: "u-2", role: "user", text: "[runweave-task-supervision:followup]", createdAt: new Date().toISOString() },
                { id: "a-2", role: "assistant", text: "第二轮续接已完成全部收尾检查。", createdAt: new Date().toISOString(), phase: "final" },
              ],
            });
          }
        }
      }
    });

    const quickTerminalProvider = new QuickInputTerminalScheduledTaskProvider(
      manager,
      terminalOptions,
      path.join(root, "classification"),
      history,
      classifier,
      fakeCodexPath,
    );
    const runtime = new ScheduledTaskRuntime(
      store,
      manager,
      new Map([
        [
          "codex",
          {
            provider: "codex",
            run: async () => {
              headlessRuns += 1;
              return {
                provider: "codex",
                threadId: `hl-thread-${randomUUID()}`,
                summary: "headless ok",
                outcome: "succeeded",
                reason: "",
              };
            },
          },
        ],
      ]),
      true,
      { maxConcurrentRuns: 2, timeoutMs: 90_000, maxOutputBytes: 64_000 },
      undefined,
      quickTerminalProvider,
    );

    try {
      await runtime.initialize();
      runtime.start();

      // Verify Case 1: Headless run completed without creating any terminal
      await waitForRunStatus(store, headlessQueued.id, (r) => r.status === "completed");
      assert.equal(headlessRuns, 1);
      assert.equal(manager.listSessions().length, 0);

      // Verify Case 2: Terminal mode high-confidence `completed` -> silent create (`activate: false`), launch flags intact, auto-closes terminal!
      nextVerdictMode = "complete";
      const succeedTask: ScheduledTask = {
        ...headlessTask,
        id: randomUUID(),
        name: "验证自动关窗",
        prompt: "/review 检查当前改动",
        executionPolicy: "full-access",
        continuationPolicy: { mode: "bounded" },
        origin: { ...headlessTask.origin!, quickInputId: randomUUID(), backgroundRuntime: "terminal" },
      };
      const succeedQueued = await store.createQuickInputRun(succeedTask, root, "term-ok", "term-ok");
      runtime.wake();
      const succeedDone = await waitForRunStatus(store, succeedQueued.id, (r) => r.status === "completed", 45_000);
      assert.equal(succeedDone.outcome, "succeeded");
      assert.equal(succeedDone.summary, "第一轮自然语言执行汇报。");
      assert.equal(succeedDone.terminalBinding, null);
      assert.equal(manager.listSessions().length, 0, "ephemeral terminal must be deleted on succeeded");
      assert.equal(createdEvents.at(-1)?.activate, undefined, "quick-input terminal must not hijack desktop focus");
      const loggedArgs = (await readFile(argsLogPath, "utf8")).split("\n").filter(Boolean);
      assert.ok(loggedArgs.includes("check_for_update_on_startup=false"), "must disable startup update check");
      assert.ok(loggedArgs.includes("--dangerously-bypass-hook-trust"), "must bypass hook trust prompt");
      assert.ok(loggedArgs.includes("danger-full-access"), "must apply full-access sandbox");
      assert.ok(loggedArgs.includes('approval_policy="never"'), "must disable interactive approval prompts");
      assert.ok(loggedArgs.includes('tui.resume_cwd="current"'), "must keep current cwd");
      assert.ok(
        loggedArgs.some((arg) => arg.includes('.trust_level="trusted"')),
        "must pre-trust registered Runweave project/worktree directory in Codex TUI",
      );
      assert.equal(loggedArgs.at(-1), "/review 检查当前改动", "must pass prompt verbatim without raw JSON wrapper");

      // Verify Case 3: In-place `continue` -> then `completed` in the same terminal -> auto-closes!
      nextVerdictMode = "continue-then-complete";
      continueCount = 0;
      const contTask: ScheduledTask = {
        ...succeedTask,
        id: randomUUID(),
        name: "验证原终端续跑",
        origin: { ...succeedTask.origin!, quickInputId: randomUUID(), backgroundRuntime: "terminal" },
      };
      const contQueued = await store.createQuickInputRun(contTask, root, "term-cont", "term-cont");
      runtime.wake();
      const contDone = await waitForRunStatus(store, contQueued.id, (r) => r.status === "completed", 45_000);
      assert.equal(contDone.outcome, "succeeded");
      assert.equal(contDone.summary, "第二轮续接已完成全部收尾检查。");
      assert.equal(manager.listSessions().length, 0, "ephemeral terminal must close after in-place continuation completes");

      // Verify Case 4: `blocked` retains live terminal (`terminalBinding.attachmentState === "ready"`) & blocks duplicate background continue
      nextVerdictMode = "blocked";
      const blockedTask: ScheduledTask = {
        ...succeedTask,
        id: randomUUID(),
        name: "验证受阻保留",
        origin: { ...succeedTask.origin!, quickInputId: randomUUID(), backgroundRuntime: "terminal" },
      };
      const blockedQueued = await store.createQuickInputRun(blockedTask, root, "term-blk", "term-blk");
      runtime.wake();
      const blockedDone = await waitForRunStatus(store, blockedQueued.id, (r) => r.status === "failed", 45_000);
      assert.equal(blockedDone.outcome, "blocked");
      assert.equal(blockedDone.terminalBinding?.attachmentState, "ready");
      assert.equal(manager.listSessions().length, 1, "blocked ephemeral terminal must be retained");
      const retainedId = blockedDone.terminalBinding!.terminalSessionId;
      assert.equal(manager.getSession(retainedId)?.alias, "快捷指令 · 验证受阻保留");
      const attachment = new ScheduledTerminalAttachment(store, manager, terminalOptions);
      // Mark active command so attachment recognizes live Codex TUI immediately without spawning a 2nd session
      const retainedSession = manager.getSession(retainedId)!;
      const retainedPanel = manager.getPanel(blockedDone.terminalBinding!.panelId)!;
      assert.ok(await tmuxService.hasSession({ sessionName: retainedSession.tmuxSessionName!, socketPath }));
      await assert.rejects(
        () => store.continueRun(blockedDone.id, blockedDone.revision ?? 1, "dup-continue", new Date().toISOString(), "reply"),
        /thread_busy/u,
      );
      void retainedPanel;
      void attachment;

      // Verify Case 5: Mid-run human input (`takenOver`) retains live terminal
      nextVerdictMode = "wait-for-takeover";
      const takeoverTask: ScheduledTask = {
        ...succeedTask,
        id: randomUUID(),
        name: "验证人工接管保留",
        origin: { ...succeedTask.origin!, quickInputId: randomUUID(), backgroundRuntime: "terminal" },
      };
      const takeoverQueued = await store.createQuickInputRun(takeoverTask, root, "term-take", "term-take");
      runtime.wake();
      const takeoverSessionId = await waitForNewSession(manager, new Set([retainedId]), 45_000);
      const takeoverSession = manager.getSession(takeoverSessionId)!;
      const takeoverPanel = manager.listPanels(takeoverSessionId)[0]!;
      const releaseHuman = beginTerminalInput(takeoverSession, takeoverPanel.tmuxPaneId, {
        kind: "edit",
        source: "line",
        submit: true,
      });
      releaseHuman();
      const takeoverDone = await waitForRunStatus(store, takeoverQueued.id, (r) => r.status === "failed", 45_000);
      assert.equal(takeoverDone.outcome, "blocked");
      assert.equal(takeoverDone.error?.code, "provider_terminal_taken_over");
      assert.equal(takeoverDone.terminalBinding?.terminalSessionId, takeoverSessionId);
      assert.equal(takeoverDone.terminalBinding?.attachmentState, "ready");
      assert.ok(manager.getSession(takeoverSessionId), "taken-over terminal must remain alive");
    } finally {
      unsub();
      await runtime.dispose();
    }
  } finally {
    if (previousZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = previousZdotdir;
    await tmuxService.killServer(socketPath).catch(() => undefined);
    await runtimeRegistry.disposeAll().catch(() => undefined);
    await manager.dispose();
    await sessionStore.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForRunStatus(
  store: ScheduledTaskStore,
  runId: string,
  predicate: (run: ScheduledRun) => boolean,
  timeoutMs = 45_000,
): Promise<ScheduledRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await store.getRun(runId);
    if (current && predicate(current)) return current;
    await new Promise((r) => setTimeout(r, 100));
  }
  const latest = await store.getRun(runId);
  throw new Error(`Timed out waiting for run ${runId}; latest=${JSON.stringify(latest)}`);
}

async function waitForNewSession(
  manager: TerminalSessionManager,
  ignoreIds: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = manager.listSessions().find((s) => !ignoreIds.has(s.id));
    if (found && manager.listPanels(found.id)[0]?.threadId) return found.id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for new quick-input terminal session");
}
