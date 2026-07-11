import type {
  AgentTeamAcceptanceSource,
  AgentTeamRun,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
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
      const verification: AgentTeamVerificationConfig = {
        planFilePath,
        testCaseFilePath: loaded.sourceFilePath,
        generatedTestCaseFilePath: null,
        acceptanceSource: "test_case_file",
      };
      return {
        verification,
        acceptance: loaded.cases,
        startLog: `Agent Team 任务已提交，${formatVerificationSource(verification)}，生成 worker 拆分提案`,
      };
    }

    const acceptanceSource: AgentTeamAcceptanceSource = planFilePath
      ? "plan_file_generated"
      : "task_generated";
    const verification: AgentTeamVerificationConfig = {
      planFilePath,
      testCaseFilePath: null,
      generatedTestCaseFilePath: null,
      acceptanceSource,
    };
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
      const verification: AgentTeamVerificationConfig = {
        planFilePath,
        testCaseFilePath: loaded.sourceFilePath,
        generatedTestCaseFilePath: null,
        acceptanceSource: "test_case_file",
      };
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
      const verification: AgentTeamVerificationConfig = {
        planFilePath,
        testCaseFilePath: null,
        generatedTestCaseFilePath: loaded.sourceFilePath,
        acceptanceSource,
      };
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
        | "activeWorkerRole"
        | "activeWorkerDispatch"
        | "clarify"
        | "proposal"
        | "workers"
        | "acceptance"
        | "loop"
        | "humanNotes"
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
    if (!targetAgent) {
      return;
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
