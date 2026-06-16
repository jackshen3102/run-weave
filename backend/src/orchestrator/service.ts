import { randomBytes } from "node:crypto";
import os from "node:os";
import type {
  OrchestratorDispatchSidecar,
  OrchestratorRunPackage,
  OrchestratorRunStatus,
  OrchestratorRoleDefinition,
  OrchestratorTimelineItem,
  TerminalEventEnvelope,
} from "@runweave/shared";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import { OrchestratorError } from "./errors";
import { DEFAULT_ROLES } from "./default-roles";
import type { CreateRunInput, DispatchInput } from "./types";
import {
  buildRunPackage,
  createRunId,
  createTimelineItem,
  upsertGoal,
} from "./domain/run-domain";
import {
  buildHumanPrompt,
  buildResultPrompt,
  buildStartupPrompt,
  buildWorkerPrompt,
  formatTerminalLabel,
  normalizeBaseUrl,
  resolveAgentCliCommand,
} from "./prompt/prompt-builders";
import { OrchestratorPaths } from "./storage/orchestrator-paths";
import { OrchestratorRoleStore } from "./storage/role-store";
import { OrchestratorRunStore } from "./storage/run-store";
import { OrchestratorSidecarStore } from "./storage/sidecar-store";
import { OrchestratorTerminalSessionResolver } from "./terminal/session-resolver";
import { OrchestratorPromptSender } from "./terminal/prompt-sender";
import { OrchestratorAgentReadinessService } from "./terminal/agent-readiness";
import { OrchestratorOutboxResolver } from "./completion/outbox-resolver";
import { normalizeTerminalRequest } from "./terminal-request";

export { OrchestratorError } from "./errors";

interface OrchestratorServiceOptions {
  terminalSessionManager: TerminalSessionManager;
  terminalEventService: TerminalEventService;
  ptyService: PtyService;
  runtimeRegistry: TerminalRuntimeRegistry;
  terminalStateService: TerminalStateService;
  tmuxService?: TmuxService;
  tmuxOutputWatcher?: TmuxOutputWatcher;
  homeDir?: string;
  cwd?: string;
}

export class OrchestratorService {
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly terminalEventService: TerminalEventService;
  private readonly ptyService: PtyService;
  private readonly runtimeRegistry: TerminalRuntimeRegistry;
  private readonly terminalStateService: TerminalStateService;
  private readonly tmuxService?: TmuxService;
  private readonly tmuxOutputWatcher?: TmuxOutputWatcher;
  private readonly paths: OrchestratorPaths;
  private readonly roleStore: OrchestratorRoleStore;
  private readonly runStore: OrchestratorRunStore;
  private readonly sidecarStore: OrchestratorSidecarStore;
  private readonly sessionResolver: OrchestratorTerminalSessionResolver;
  private readonly promptSender: OrchestratorPromptSender;
  private readonly agentReadiness: OrchestratorAgentReadinessService;
  private readonly outboxResolver: OrchestratorOutboxResolver;
  private controlPlaneBaseUrl: string | null = null;
  private readonly routeTable = new Map<string, string>();

  constructor(options: OrchestratorServiceOptions) {
    this.terminalSessionManager = options.terminalSessionManager;
    this.terminalEventService = options.terminalEventService;
    this.ptyService = options.ptyService;
    this.runtimeRegistry = options.runtimeRegistry;
    this.terminalStateService = options.terminalStateService;
    this.tmuxService = options.tmuxService;
    this.tmuxOutputWatcher = options.tmuxOutputWatcher;
    this.paths = new OrchestratorPaths(
      this.terminalSessionManager,
      options.homeDir ?? os.homedir(),
      options.cwd ?? process.cwd(),
    );
    this.roleStore = new OrchestratorRoleStore(this.paths);
    this.runStore = new OrchestratorRunStore(
      this.terminalSessionManager,
      this.paths,
    );
    this.sidecarStore = new OrchestratorSidecarStore(this.paths);
    const terminalRuntimeOptions = {
      terminalSessionManager: this.terminalSessionManager,
      ptyService: this.ptyService,
      runtimeRegistry: this.runtimeRegistry,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
    };
    this.sessionResolver = new OrchestratorTerminalSessionResolver({
      ...terminalRuntimeOptions,
      terminalEventService: this.terminalEventService,
    });
    this.promptSender = new OrchestratorPromptSender(terminalRuntimeOptions);
    this.agentReadiness = new OrchestratorAgentReadinessService({
      ...terminalRuntimeOptions,
      terminalStateService: this.terminalStateService,
    });
    this.outboxResolver = new OrchestratorOutboxResolver({
      terminalSessionManager: this.terminalSessionManager,
      runStore: this.runStore,
      paths: this.paths,
      sidecarStore: this.sidecarStore,
    });
  }

  async initialize(): Promise<void> {
    const roles = await this.listRoles();
    if (roles.length === 0) {
      await this.saveRoles(DEFAULT_ROLES);
    }
    await this.rebuildRouteTable();
    this.terminalEventService.subscribe((event) => {
      void this.handleTerminalEvent(event);
    });
  }

  setControlPlaneBaseUrl(baseUrl: string | null | undefined): void {
    this.controlPlaneBaseUrl = normalizeBaseUrl(baseUrl);
  }

  async listRoles(): Promise<OrchestratorRoleDefinition[]> {
    return this.roleStore.listRoles();
  }

  async saveRoles(
    roles: OrchestratorRoleDefinition[],
  ): Promise<OrchestratorRoleDefinition[]> {
    return this.roleStore.saveRoles(roles);
  }

  async listRuns(projectId: string): Promise<OrchestratorRunPackage[]> {
    return this.runStore.listRuns(projectId);
  }

  async getRun(runId: string): Promise<OrchestratorRunPackage | null> {
    return this.runStore.getRun(runId);
  }

  async previewStartupPrompt(
    input: CreateRunInput,
  ): Promise<{ runId: string; prompt: string }> {
    const project = this.terminalSessionManager.getProject(input.projectId);
    if (!project) {
      throw new OrchestratorError(404, "Terminal project not found");
    }
    const run = buildRunPackage({
      input,
      runId: input.runId ?? createRunId(),
      orchestratorSessionId: null,
      now: new Date().toISOString(),
    });
    return {
      runId: run.runId,
      prompt: buildStartupPrompt(
        run,
        input.orchestrator.startupPrompt,
        this.describeRoleTerminalMappings(run),
        this.resolveControlPlaneBaseUrl(),
      ),
    };
  }

  async createRun(input: CreateRunInput): Promise<OrchestratorRunPackage> {
    const project = this.terminalSessionManager.getProject(input.projectId);
    if (!project) {
      throw new OrchestratorError(404, "Terminal project not found");
    }
    const now = new Date().toISOString();
    const runId = input.runId ?? createRunId(now);
    if (await this.getRun(runId)) {
      throw new OrchestratorError(409, "Orchestrator run already exists");
    }
    const orchestratorSession = await this.sessionResolver.resolveRunSession({
      projectId: input.projectId,
      binding: input.orchestrator.binding,
      terminal: normalizeTerminalRequest(input.orchestrator.terminal),
    });
    const run = buildRunPackage({
      input,
      runId,
      orchestratorSessionId: orchestratorSession.id,
      now,
      timelineItem: (input) => this.timelineItem(input),
    });
    await this.runStore.writeRun(run);
    this.routeTable.set(run.runId, orchestratorSession.id);
    await this.agentReadiness.ensureOrchestratorAgentReady(
      orchestratorSession,
      input.orchestrator.terminal,
    );
    await this.promptSender.sendPromptToAgent(
      orchestratorSession,
      buildStartupPrompt(
        run,
        input.orchestrator.startupPrompt,
        this.describeRoleTerminalMappings(run),
        this.resolveControlPlaneBaseUrl(),
      ),
    );
    return this.updateRun(run, {
      timeline: [
        this.timelineItem({
          type: "direct_send",
          title: "Startup prompt sent to orchestrator",
          terminalSessionId: orchestratorSession.id,
        }),
      ],
    });
  }

  private describeRoleTerminalMappings(run: OrchestratorRunPackage): string[] {
    return run.roles.map((role) => {
      const roleName = `${role.name}(${role.id})`;
      const command = resolveAgentCliCommand(role.terminal.command);
      if (role.binding.mode !== "reuse") {
        return `${roleName}: 按角色配置新建 worker 终端；创建后使用 \`rw terminal send <新终端ID> --agent ${command} --stdin --json\` 发送 worker prompt。`;
      }
      const sessionId = role.binding.sessionId;
      const session = sessionId
        ? this.terminalSessionManager.getSession(sessionId)
        : null;
      if (!session) {
        return `${roleName}: 复用终端 ${sessionId ?? "unknown"}；发送时使用 \`rw terminal send ${sessionId ?? "<终端ID>"} --agent ${command} --stdin --json\`。`;
      }
      return `${roleName}: 复用终端 ${formatTerminalLabel(session)}，终端 ID 为 ${session.id}；发送时使用 \`rw terminal send ${session.id} --agent ${command} --stdin --json\`。`;
    });
  }

  async dispatchGoal(input: DispatchInput): Promise<OrchestratorRunPackage> {
    const run = await this.requireRun(input.runId);
    const role = run.roles.find((item) => item.id === input.roleId);
    if (!role) {
      throw new OrchestratorError(404, "Run role not found");
    }
    const session = await this.sessionResolver.resolveRunSession({
      projectId: run.projectId,
      binding: {
        mode: input.newSession ? "new" : role.binding.mode,
        sessionId: input.sessionId ?? role.binding.sessionId,
      },
      terminal: normalizeTerminalRequest(role.terminal),
    });
    const sidecar: OrchestratorDispatchSidecar = {
      sessionId: session.id,
      role: role.id,
      goalId: input.goalId,
      runId: run.runId,
      dispatchedAt: new Date().toISOString(),
    };
    await this.sidecarStore.writeDispatchSidecar(run.projectId, sidecar);

    const existingGoal = run.goals.find((goal) => goal.id === input.goalId);
    upsertGoal(run.goals, {
      id: input.goalId,
      desc: input.desc ?? input.query,
      deps: [],
      status: "running",
      assignedRole: role.id,
      sessionId: session.id,
      attempts: (existingGoal?.attempts ?? 0) + 1,
    });

    await this.promptSender.sendPromptToAgent(
      session,
      buildWorkerPrompt({
        run,
        role,
        goalId: input.goalId,
        query: input.query,
      }),
    );
    return this.updateRun(run, {
      goals: run.goals,
      timeline: [
        this.timelineItem({
          type: "dispatch",
          title: `Dispatched ${input.goalId} to ${role.id}`,
          detail: input.query,
          goalId: input.goalId,
          roleId: role.id,
          terminalSessionId: session.id,
        }),
      ],
    });
  }

  async injectPrompt(runId: string, text: string): Promise<OrchestratorRunPackage> {
    const run = await this.requireRun(runId);
    const orchestratorSessionId = run.orchestrator.sessionId;
    if (!orchestratorSessionId) {
      throw new OrchestratorError(409, "Run has no orchestrator session");
    }
    const session = this.requireSession(orchestratorSessionId);
    const inboxItem = {
      id: `human_${Date.now()}_${randomBytes(2).toString("hex")}`,
      at: new Date().toISOString(),
      text,
    };
    await this.promptSender.sendPromptToAgent(
      session,
      buildHumanPrompt(text),
    );
    return this.updateRun(run, {
      status: run.status === "paused" || run.status === "need_human" ? "running" : run.status,
      humanInbox: [...run.humanInbox, inboxItem],
      timeline: [
        this.timelineItem({
          type: "human",
          title: "Human prompt injected",
          detail: text,
          terminalSessionId: orchestratorSessionId,
        }),
      ],
    });
  }

  async setRunStatus(
    runId: string,
    status: OrchestratorRunStatus,
  ): Promise<OrchestratorRunPackage> {
    const run = await this.requireRun(runId);
    return this.updateRun(run, {
      status,
      timeline: [
        this.timelineItem({
          type: "human",
          title: `Run status set to ${status}`,
          terminalSessionId: run.orchestrator.sessionId ?? null,
        }),
      ],
    });
  }

  private async handleTerminalEvent(event: TerminalEventEnvelope): Promise<void> {
    if (event.kind !== "completion") {
      return;
    }
    const outbox = await this.outboxResolver.resolveOutbox(event);
    if (!outbox?.runId) {
      return;
    }
    const run = await this.getRun(outbox.runId);
    if (!run) {
      return;
    }
    if (event.terminalSessionId === run.orchestrator.sessionId) {
      return;
    }
    const existingGoal = outbox.goalId
      ? run.goals.find((item) => item.id === outbox.goalId)
      : null;
    const goal = outbox.goalId
      ? upsertGoal(run.goals, {
          id: outbox.goalId,
          desc: outbox.summary,
          deps: [],
          status: outbox.status === "failed" ? "failed" : "done",
          assignedRole: outbox.role ?? null,
          sessionId: outbox.sessionId,
          result: outbox,
          attempts: existingGoal?.attempts ?? 1,
        })
      : null;
    if (goal) {
      goal.status = outbox.status === "failed" ? "failed" : "done";
      goal.result = outbox;
      goal.sessionId = outbox.sessionId;
      goal.assignedRole = outbox.role ?? goal.assignedRole;
    }
    const nextTimeline: OrchestratorTimelineItem[] = [
      this.timelineItem({
        type: "worker_result",
        title: `Worker result ${outbox.goalId ?? outbox.sessionId}`,
        detail: outbox.summary,
        goalId: outbox.goalId ?? null,
        roleId: outbox.role ?? null,
        terminalSessionId: outbox.sessionId,
      }),
    ];

    if (run.status === "paused") {
      await this.updateRun(run, { goals: run.goals, timeline: nextTimeline });
      return;
    }

    const orchestratorSession = run.orchestrator.sessionId
      ? this.terminalSessionManager.getSession(run.orchestrator.sessionId)
      : null;
    if (!orchestratorSession) {
      await this.updateRun(run, { goals: run.goals, timeline: nextTimeline });
      return;
    }
    await this.promptSender.sendPromptToAgent(
      orchestratorSession,
      buildResultPrompt(outbox),
    );
    nextTimeline.push(
      this.timelineItem({
        type: "direct_send",
        title: "Worker result sent to orchestrator",
        goalId: outbox.goalId ?? null,
        roleId: outbox.role ?? null,
        terminalSessionId: orchestratorSession.id,
      }),
    );
    await this.updateRun(run, { goals: run.goals, timeline: nextTimeline });
  }

  private resolveControlPlaneBaseUrl(): string | null {
    return this.controlPlaneBaseUrl ?? normalizeBaseUrl(process.env.RUNWEAVE_BASE_URL);
  }

  private async rebuildRouteTable(): Promise<void> {
    for (const project of this.terminalSessionManager.listProjects()) {
      for (const run of await this.listRuns(project.id)) {
        if (
          (run.status === "running" || run.status === "paused") &&
          run.orchestrator.sessionId
        ) {
          this.routeTable.set(run.runId, run.orchestrator.sessionId);
        }
      }
    }
  }

  private async requireRun(runId: string): Promise<OrchestratorRunPackage> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new OrchestratorError(404, "Orchestrator run not found");
    }
    return run;
  }

  private requireSession(terminalSessionId: string): TerminalSessionRecord {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      throw new OrchestratorError(404, "Terminal session not found");
    }
    return session;
  }

  private async updateRun(
    run: OrchestratorRunPackage,
    patch: Partial<Pick<OrchestratorRunPackage, "status" | "goals" | "humanInbox">> & {
      timeline?: OrchestratorTimelineItem[];
    },
  ): Promise<OrchestratorRunPackage> {
    const next: OrchestratorRunPackage = {
      ...run,
      ...patch,
      timeline: [...(patch.timeline ?? []), ...run.timeline],
      updatedAt: new Date().toISOString(),
    };
    await this.runStore.writeRun(next);
    return next;
  }

  private timelineItem(
    input: Omit<OrchestratorTimelineItem, "id" | "at">,
  ): OrchestratorTimelineItem {
    return createTimelineItem(input);
  }
}
