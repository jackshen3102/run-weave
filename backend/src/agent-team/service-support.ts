import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AgentTeamAcceptanceSource,
  AgentTeamRun,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
  AgentTeamWorker,
  AgentTeamWorkerRole,
  CreateAgentTeamRunRequest,
  ProposeAgentTeamSplitRequest,
} from "@runweave/shared/agent-team";
import type {
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../terminal/manager";
import { getAgentForCommand } from "../terminal/terminal-state-service";
import { AgentTeamError } from "./errors";
import {
  loadAcceptanceCasesFromMarkdown,
  resolveAgentTeamProjectFile,
} from "./acceptance-case-loader";
import type { PreparedAgentTeamAcceptance } from "./service-types";
import {
  assertGeneratedTestCaseFilePath,
  formatVerificationSource,
} from "./service-run-policy";
import { buildAgentTeamPanelRole } from "./service-workflow-policy";
import { AgentTeamServiceContext, agentTeamLogger } from "./service-context";

const WORKER_THREAD_READINESS_TIMEOUT_MS = 10_000;

export class AgentTeamServiceSupport extends AgentTeamServiceContext {
  protected resolveProjectRoot(projectId: string, cwd: string): string | null {
    return (
      this.terminalSessionManager.getProject(projectId)?.path ?? cwd ?? null
    );
  }

  protected resolveRequiredProjectRoot(projectId: string, cwd: string): string {
    const projectRoot = this.resolveProjectRoot(projectId, cwd);
    if (!projectRoot) {
      throw new AgentTeamError(409, "当前项目目录不可用，无法解析验收来源文件");
    }
    return projectRoot;
  }

  protected async prepareInitialAcceptance(
    input: CreateAgentTeamRunRequest,
    projectRoot: string,
  ): Promise<PreparedAgentTeamAcceptance> {
    const planFilePath = await this.resolveOptionalProjectFilePath(
      projectRoot,
      input.planFilePath,
      "计划文件",
    );
    if (input.testCaseFilePath) {
      const loaded = await loadAcceptanceCasesFromMarkdown({
        projectRoot,
        requestedPath: input.testCaseFilePath,
      });
      const verification = await this.withVerificationDigests(projectRoot, {
        planFilePath,
        testCaseFilePath: loaded.sourceFilePath,
        generatedTestCaseFilePath: null,
        acceptanceSource: "test_case_file",
      });
      return {
        verification,
        acceptance: loaded.cases,
        startLog: `Agent Team 任务已提交，${formatVerificationSource(verification)}，生成 worker 拆分提案`,
      };
    }

    const acceptanceSource: AgentTeamAcceptanceSource = planFilePath
      ? "plan_file_generated"
      : "task_generated";
    const verification = await this.withVerificationDigests(projectRoot, {
      planFilePath,
      testCaseFilePath: null,
      generatedTestCaseFilePath: null,
      acceptanceSource,
    });
    return {
      verification,
      acceptance: [],
      startLog:
        acceptanceSource === "plan_file_generated"
          ? `缺少测试案例文件，已要求主 Agent 基于计划文件 ${planFilePath} 生成 docs/testing 用例`
          : "缺少测试案例文件，已要求主 Agent 基于任务描述生成 docs/testing 用例",
    };
  }

  protected async prepareSplitAcceptance(
    run: AgentTeamRun,
    input: Pick<
      ProposeAgentTeamSplitRequest,
      | "acceptance"
      | "planFilePath"
      | "testCaseFilePath"
      | "generatedTestCaseFilePath"
    >,
  ): Promise<PreparedAgentTeamAcceptance> {
    const session = this.requireSession(run.terminalSessionId);
    const projectRoot = this.resolveRequiredProjectRoot(
      run.projectId,
      session.cwd,
    );
    const planFilePath =
      (await this.resolveOptionalProjectFilePath(
        projectRoot,
        input.planFilePath,
        "计划文件",
      )) ??
      run.verification?.planFilePath ??
      null;

    if (input.testCaseFilePath) {
      const loaded = await loadAcceptanceCasesFromMarkdown({
        projectRoot,
        requestedPath: input.testCaseFilePath,
      });
      const verification = await this.withVerificationDigests(projectRoot, {
        planFilePath,
        testCaseFilePath: loaded.sourceFilePath,
        generatedTestCaseFilePath: null,
        acceptanceSource: "test_case_file",
      });
      return {
        verification,
        acceptance: loaded.cases,
        startLog: `使用测试案例文件 ${loaded.sourceFilePath} 生成验收用例`,
      };
    }

    if (input.generatedTestCaseFilePath) {
      const loaded = await loadAcceptanceCasesFromMarkdown({
        projectRoot,
        requestedPath: input.generatedTestCaseFilePath,
      });
      assertGeneratedTestCaseFilePath(loaded.sourceFilePath);
      const acceptanceSource =
        run.verification?.acceptanceSource === "plan_file_generated"
          ? "plan_file_generated"
          : run.verification?.acceptanceSource === "task_generated"
            ? "task_generated"
            : planFilePath
              ? "plan_file_generated"
              : "task_generated";
      const verification = await this.withVerificationDigests(projectRoot, {
        planFilePath,
        testCaseFilePath: null,
        generatedTestCaseFilePath: loaded.sourceFilePath,
        acceptanceSource,
      });
      return {
        verification,
        acceptance: loaded.cases,
        startLog: `使用生成的测试案例文件 ${loaded.sourceFilePath} 生成验收用例`,
      };
    }

    throw new AgentTeamError(
      400,
      "缺少可追溯测试案例文件：请提供 testCaseFilePath 或 generatedTestCaseFilePath",
    );
  }

  protected async resolveOptionalProjectFilePath(
    projectRoot: string,
    requestedPath: string | null | undefined,
    label: string,
  ): Promise<string | null> {
    if (!requestedPath?.trim()) {
      return null;
    }
    const resolved = await resolveAgentTeamProjectFile(
      projectRoot,
      requestedPath,
      label,
    );
    return resolved.relativePath;
  }

  protected async assertVerificationSourcesUnchanged(
    run: AgentTeamRun,
  ): Promise<void> {
    if (!run.verification) {
      return;
    }
    const session = this.requireSession(run.terminalSessionId);
    const projectRoot = this.resolveRequiredProjectRoot(
      run.projectId,
      session.cwd,
    );
    const current = await this.withVerificationDigests(
      projectRoot,
      run.verification,
    );
    const fields = [
      ["计划文件", run.verification.planSha256, current.planSha256],
      ["测试案例文件", run.verification.testCaseSha256, current.testCaseSha256],
      [
        "生成测试案例文件",
        run.verification.generatedTestCaseSha256,
        current.generatedTestCaseSha256,
      ],
    ] as const;
    const drift = fields.find(([, expected, actual]) => expected !== actual);
    if (drift) {
      throw new AgentTeamError(
        409,
        `${drift[0]}已变化，旧 review/acceptance 失效：expected ${drift[1] ?? "null"}，actual ${drift[2] ?? "null"}`,
      );
    }
  }

  protected effectiveTestCaseSha256(
    verification: AgentTeamVerificationConfig | null | undefined,
  ): string | null {
    return (
      verification?.testCaseSha256 ??
      verification?.generatedTestCaseSha256 ??
      null
    );
  }

  protected async pauseForCheckpointError(
    run: AgentTeamRun,
    reason: string,
  ): Promise<AgentTeamRun> {
    return this.updateRun(run, {
      status: "need_human",
      activeWorkerRole: null,
      activeWorkerDispatch: null,
      workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
      loop: { ...run.loop, escalated: true, lastReason: reason },
      logs: [...run.logs, `⏸ Review checkpoint 已暂停：${reason}`],
    });
  }

  protected async pauseForWorkerDispatchError(
    run: AgentTeamRun,
    role: AgentTeamWorkerRole,
    reason: string,
  ): Promise<AgentTeamRun> {
    return this.updateRun(run, {
      status: "need_human",
      activeWorkerRole: role,
      activeWorkerDispatch: null,
      workers: run.workers.map((worker) => ({ ...worker, frozen: true })),
      loop: { ...run.loop, escalated: true, lastReason: reason },
      logs: [...run.logs, `⏸ ${role} worker 投递已暂停：${reason}`],
    });
  }

  private async withVerificationDigests(
    projectRoot: string,
    verification: AgentTeamVerificationConfig,
  ): Promise<AgentTeamVerificationConfig> {
    return {
      ...verification,
      planSha256: await this.hashProjectFile(
        projectRoot,
        verification.planFilePath,
      ),
      testCaseSha256: await this.hashProjectFile(
        projectRoot,
        verification.testCaseFilePath,
      ),
      generatedTestCaseSha256: await this.hashProjectFile(
        projectRoot,
        verification.generatedTestCaseFilePath,
      ),
    };
  }

  private async hashProjectFile(
    projectRoot: string,
    relativePath: string | null | undefined,
  ): Promise<string | null> {
    if (!relativePath) {
      return null;
    }
    const resolved = await resolveAgentTeamProjectFile(
      projectRoot,
      relativePath,
      "验收来源文件",
    );
    const content = await readFile(resolved.absolutePath);
    return createHash("sha256").update(content).digest("hex");
  }

  protected async enqueue<T>(
    runId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.eventQueues.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.eventQueues.get(runId) === next) {
        this.eventQueues.delete(runId);
      }
    }
  }

  protected incrementPendingCompletionRound(runId: string): void {
    this.pendingCompletionRounds.set(
      runId,
      (this.pendingCompletionRounds.get(runId) ?? 0) + 1,
    );
  }

  protected decrementPendingCompletionRound(runId: string): void {
    const nextCount = (this.pendingCompletionRounds.get(runId) ?? 0) - 1;
    if (nextCount > 0) {
      this.pendingCompletionRounds.set(runId, nextCount);
      return;
    }
    this.pendingCompletionRounds.delete(runId);
  }

  protected async trySendToMain(
    run: AgentTeamRun,
    text: string,
  ): Promise<void> {
    const session = this.terminalSessionManager.getSession(
      run.terminalSessionId,
    );
    if (!session) {
      return;
    }
    try {
      await this.promptSender.sendPromptToPane(
        session,
        text,
        run.mainPanelId ? { panelId: run.mainPanelId } : undefined,
      );
    } catch (error) {
      agentTeamLogger.warn("agent-team.main_prompt.failed", {
        message: "Could not inject prompt into main pane",
        runId: run.runId,
        error,
      });
    }
  }

  protected async submitWorkerDispatchPrompt(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
    worker: AgentTeamWorker,
    prompt: string,
  ): Promise<void> {
    if (!worker.panelId) {
      throw new AgentTeamError(409, `${worker.role} worker pane 不存在`);
    }
    const expectedAgent = getAgentForCommand(terminal.command ?? null);
    const panel = this.terminalSessionManager.getPanel(worker.panelId);
    let readyPanel: TerminalPanelRecord | null | undefined = panel;
    const startingThreadId =
      expectedAgent &&
      panel?.terminalState?.state === "agent_starting" &&
      panel.lastThreadProvider === expectedAgent &&
      panel.lastThreadStatus === "idle"
        ? panel.lastThreadId?.trim()
        : null;
    if (expectedAgent && startingThreadId) {
      readyPanel = await this.waitForWorkerThreadReadiness(
        worker.panelId,
        expectedAgent,
        startingThreadId,
      );
      if (!readyPanel) {
        throw new AgentTeamError(
          409,
          `${worker.role} worker 的 agent thread 未以已记录身份进入 ready，禁止向 agent_starting pane 投递`,
        );
      }
    }
    const readyPanelAgent = readyPanel
      ? (readyPanel.terminalState?.agent ??
        getAgentForCommand(readyPanel.activeCommand))
      : null;
    const reusableActiveThread =
      expectedAgent &&
      readyPanel?.status === "running" &&
      readyPanelAgent === expectedAgent &&
      readyPanel.terminalState?.state === "agent_idle";
    if (reusableActiveThread) {
      await this.promptSender.sendPromptToPane(session, prompt, {
        panelId: worker.panelId,
      });
      return;
    }

    const resumableThreadId =
      expectedAgent &&
      panel?.status === "running" &&
      panel.terminalState?.state === "shell_idle" &&
      panel.lastThreadProvider === expectedAgent &&
      panel.lastThreadStatus === "idle"
        ? panel.lastThreadId?.trim()
        : null;
    if (resumableThreadId) {
      await this.agentLaunch.submitAgentResume(session, terminal, {
        panelId: worker.panelId,
        threadId: resumableThreadId,
        prompt,
      });
      return;
    }

    const hasExistingWorkerContext = Boolean(
      run.consumedWorkerDispatches?.some(
        (receipt) => receipt.role === worker.role,
      ) ||
        panel?.threadId ||
        panel?.lastThreadId ||
        readyPanelAgent,
    );
    if (hasExistingWorkerContext) {
      throw new AgentTeamError(
        409,
        `${worker.role} worker 的既有 agent thread 当前不可复用，禁止新开 thread 丢失上下文`,
      );
    }

    await this.agentLaunch.submitAgentLaunch(session, terminal, {
      panelId: worker.panelId,
      prompt,
    });
  }

  private async waitForWorkerThreadReadiness(
    panelId: string,
    expectedAgent: NonNullable<ReturnType<typeof getAgentForCommand>>,
    expectedThreadId: string,
  ): Promise<TerminalPanelRecord | null> {
    const isReady = (candidate: TerminalPanelRecord | undefined) =>
      candidate?.status === "running" &&
      candidate.terminalState?.state === "agent_idle" &&
      candidate.terminalState.agent === expectedAgent &&
      candidate.threadProvider === expectedAgent &&
      candidate.threadId?.trim() === expectedThreadId;
    const current = this.terminalSessionManager.getPanel(panelId);
    if (isReady(current)) {
      return current ?? null;
    }
    return new Promise((resolve) => {
      let unsubscribe: () => void = () => undefined;
      let settled = false;
      const finish = (candidate: TerminalPanelRecord | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(candidate);
      };
      const inspect = (candidate: TerminalPanelRecord | undefined) => {
        if (isReady(candidate)) {
          finish(candidate ?? null);
          return;
        }
        if (
          !candidate ||
          candidate.status !== "running" ||
          (candidate.terminalState?.agent &&
            candidate.terminalState.agent !== expectedAgent) ||
          candidate.terminalState?.state === "shell_idle" ||
          candidate.terminalState?.state === "agent_running"
        ) {
          finish(null);
        }
      };
      const timeout = setTimeout(
        () => finish(null),
        WORKER_THREAD_READINESS_TIMEOUT_MS,
      );
      unsubscribe = this.terminalSessionManager.subscribePanelMutations(
        panelId,
        inspect,
      );
      inspect(this.terminalSessionManager.getPanel(panelId));
    });
  }

  protected async restoreMainPaneFocus(
    session: TerminalSessionRecord,
    mainPanelId: string | null | undefined,
  ): Promise<void> {
    if (!mainPanelId || !this.tmuxService) {
      return;
    }
    const panel = this.terminalSessionManager.getPanel(mainPanelId);
    if (!panel) {
      return;
    }
    try {
      await this.tmuxService.selectPane({
        ...this.tmuxService.buildTarget(session.id),
        paneId: panel.tmuxPaneId,
      });
      await this.terminalSessionManager.focusPanel(session.id, mainPanelId);
      const workspace = this.terminalSessionManager.getPanelWorkspace(
        session.id,
      );
      if (workspace) {
        this.terminalEventService.record({
          kind: "terminal_panel_focused",
          terminalSessionId: session.id,
          projectId: session.projectId,
          payload: {
            terminalSessionId: session.id,
            panelId: mainPanelId,
            alias: panel.alias,
            role: panel.role,
            source: "api",
            workspace,
          } as never,
        });
      }
    } catch (error) {
      agentTeamLogger.warn("agent-team.restore_main_focus.failed", {
        message: "Could not restore main pane focus after split",
        terminalSessionId: session.id,
        panelId: mainPanelId,
        error,
      });
    }
  }

  protected async updateRun(
    run: AgentTeamRun,
    patch: Partial<
      Pick<
        AgentTeamRun,
        | "phase"
        | "status"
        | "options"
        | "terminal"
        | "task"
        | "verification"
        | "reviewCheckpoint"
        | "activeWorkerRole"
        | "activeWorkerDispatch"
        | "workerDispatchProtocolVersion"
        | "consumedWorkerDispatches"
        | "clarify"
        | "proposal"
        | "workers"
        | "acceptance"
        | "loop"
        | "humanNotes"
        | "agentInterventions"
        | "findingDecisions"
        | "pendingFindingDecision"
        | "logs"
        | "mainPanelId"
      >
    >,
  ): Promise<AgentTeamRun> {
    const next: AgentTeamRun = {
      ...run,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.runStore.writeRun(next);
    return next;
  }

  protected async requireRun(runId: string): Promise<AgentTeamRun> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new AgentTeamError(404, "Agent-team run not found");
    }
    return run;
  }

  protected requireSession(terminalSessionId: string): TerminalSessionRecord {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new AgentTeamError(404, "Terminal session not found");
    }
    return session;
  }

  protected requireAgentTeamTerminalAvailable(
    session: TerminalSessionRecord,
    terminal: AgentTeamTerminal,
  ): void {
    const targetAgent = getAgentForCommand(terminal.command ?? null);
    if (!targetAgent || (targetAgent !== "codex" && targetAgent !== "traex")) {
      throw new AgentTeamError(
        409,
        `Agent-team terminal command "${terminal.command ?? ""}" does not support lifecycle bootstrap`,
      );
    }
    const currentState = this.terminalStateService.getCurrent(
      session.id,
      session,
    );
    if (currentState.state === "agent_running") {
      throw new AgentTeamError(
        409,
        `Agent-team terminal is already running agent "${currentState.agent ?? "unknown"}"`,
      );
    }
    if (
      currentState.state !== "shell_idle" &&
      currentState.agent &&
      currentState.agent !== targetAgent
    ) {
      throw new AgentTeamError(
        409,
        `Agent-team terminal is already using agent "${currentState.agent}"`,
      );
    }
  }

  protected findReusableWorkerPanel(
    terminalSessionId: string,
    runId: string,
    alias: string,
    role: string,
  ): TerminalPanelRecord | null {
    return (
      this.terminalSessionManager
        .listPanels(terminalSessionId)
        .find(
          (panel) =>
            panel.status === "running" &&
            panel.agentTeamRunId === runId &&
            panel.alias === alias &&
            panel.role === role,
        ) ?? null
    );
  }

  protected resolveWorkerPanelAlias(
    terminalSessionId: string,
    baseAlias: string,
    runId: string,
    role: AgentTeamWorkerRole,
  ): string {
    const panels = this.terminalSessionManager.listPanels(terminalSessionId);
    const panelRole = buildAgentTeamPanelRole(runId, role);
    const reusablePanel = panels.find(
      (panel) =>
        panel.status === "running" &&
        panel.agentTeamRunId === runId &&
        panel.alias === baseAlias &&
        panel.role === panelRole,
    );
    if (reusablePanel || !panels.some((panel) => panel.alias === baseAlias)) {
      return baseAlias;
    }
    let suffix = 2;
    let nextAlias = `${baseAlias}-${suffix}`;
    while (panels.some((panel) => panel.alias === nextAlias)) {
      suffix += 1;
      nextAlias = `${baseAlias}-${suffix}`;
    }
    return nextAlias;
  }
}
