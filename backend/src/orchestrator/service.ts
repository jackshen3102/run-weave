import { randomBytes } from "node:crypto";
import os from "node:os";
import type {
  OrchestratorDispatchSidecar,
  HumanGateVerdict,
  HumanGatePhase,
  OrchestratorWorkerOutbox,
  SubmitOrchestratorHumanGateRequest,
  OrchestratorRoundConfirmation,
  OrchestratorRunPackage,
  OrchestratorRunStatus,
  OrchestratorRoleDefinition,
  OrchestratorTimelineItem,
  SubmitOrchestratorRoundConfirmationRequest,
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
import { logger } from "../logging";
import { OrchestratorError } from "./errors";
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
import {
  advancePhaseForDispatch,
  advancePhaseForWorkerResult,
  canMarkDone,
  createPendingRoundConfirmation,
  resolveHumanGateTransition,
  shouldRequireRoundConfirmation,
} from "./workflow/do-a-idem";

export { OrchestratorError } from "./errors";

type TerminalCompletionEvent = Extract<
  TerminalEventEnvelope,
  { kind: "completion" }
>;
type WorkerOutboxWithRunId = OrchestratorWorkerOutbox & { runId: string };
type WorkerResultTransition = {
  patch: Partial<
    Pick<
      OrchestratorRunPackage,
      | "status"
      | "currentPhase"
      | "pendingRoundConfirmation"
      | "humanGateVerdicts"
    >
  >;
  autoGatePrompt?: string;
  timelineItems?: OrchestratorTimelineItem[];
};

const orchestratorServiceLogger = logger.child({
  component: "orchestrator-service",
});

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
  private readonly terminalEventQueues = new Map<string, Promise<void>>();

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
    await this.roleStore.ensureInitializedRoles();
    await this.rebuildRouteTable();
    this.terminalEventService.subscribe((event) => {
      void this.handleTerminalEvent(event).catch((error) => {
        orchestratorServiceLogger.error("orchestrator.terminal_event.failed", {
          message: "Failed to handle terminal event",
          eventId: event.id,
          terminalSessionId: event.terminalSessionId,
          kind: event.kind,
          error,
        });
      });
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
      input.orchestrator.binding,
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
    const project = this.terminalSessionManager.getProject(run.projectId);
    return run.roles.map((role) => {
      const roleName = `${role.name}(${role.id})`;
      const command = resolveAgentCliCommand(role.terminal.command);
      if (role.binding.mode !== "reuse") {
        const cwd = role.terminal.cwd?.trim() || project?.path || "<项目路径>";
        return `${roleName}: 新建 worker 终端时先运行 \`rw terminal create --project-id ${run.projectId} --cwd ${shellQuote(cwd)} --json\`，从 JSON 读取 terminalSessionId；随后使用 \`rw terminal send <terminalSessionId> --agent ${command} --stdin --json\` 发送 worker prompt。`;
      }
      const sessionId = role.binding.sessionId;
      const panelFlag = role.binding.panelAlias
        ? ` --panel ${shellQuote(role.binding.panelAlias)}`
        : role.binding.role
          ? ` --role ${shellQuote(role.binding.role)}`
          : "";
      const session = sessionId
        ? this.terminalSessionManager.getSession(sessionId)
        : null;
      if (!session) {
        return `${roleName}: 复用终端 ${sessionId ?? "unknown"}；发送时使用 \`rw terminal send ${sessionId ?? "<终端ID>"}${panelFlag} --agent ${command} --stdin --json\`。`;
      }
      return `${roleName}: 复用终端 ${formatTerminalLabel(session)}，终端 ID 为 ${session.id}；发送时使用 \`rw terminal send ${session.id}${panelFlag} --agent ${command} --stdin --json\`。`;
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
        panelId: role.binding.panelId,
        panelAlias: role.binding.panelAlias,
        role: role.binding.role,
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
      role.binding,
    );
    const nextPhase = advancePhaseForDispatch(role.id);
    return this.updateRun(run, {
      goals: run.goals,
      ...(nextPhase ? { currentPhase: nextPhase } : {}),
      timeline: [
        this.timelineItem({
          type: "dispatch",
          title: `Dispatched ${input.goalId} to ${role.id}`,
          detail: input.query,
          goalId: input.goalId,
          roleId: role.id,
          terminalSessionId: session.id,
          terminalPanelId: role.binding.panelId ?? null,
          panelAlias: role.binding.panelAlias ?? role.binding.role ?? null,
        }),
      ],
    });
  }

  async submitHumanGate(
    runId: string,
    input: SubmitOrchestratorHumanGateRequest,
  ): Promise<OrchestratorRunPackage> {
    const run = await this.requireRun(runId);
    if (run.currentPhase !== input.phase) {
      throw new OrchestratorError(
        409,
        "Human gate phase does not match current phase",
      );
    }
    const reason = input.reason?.trim() || null;
    if (input.verdict === "rejected" && !reason) {
      throw new OrchestratorError(400, "Rejected human gate requires a reason");
    }
    const transition = resolveHumanGateTransition({
      phase: input.phase,
      verdict: input.verdict,
    });
    const verdict: HumanGateVerdict = {
      id: `gate_${Date.now()}_${randomBytes(2).toString("hex")}`,
      phase: input.phase,
      verdict: input.verdict,
      reason,
      at: new Date().toISOString(),
    };
    const orchestratorSession = run.orchestrator.sessionId
      ? this.terminalSessionManager.getSession(run.orchestrator.sessionId)
      : null;
    if (orchestratorSession) {
      await this.promptSender.sendPromptToAgent(
        orchestratorSession,
        buildHumanPrompt(
          formatHumanGatePrompt(verdict, transition.currentPhase),
        ),
        run.orchestrator.binding,
      );
    }
    return this.updateRun(run, {
      status: transition.status,
      currentPhase: transition.currentPhase,
      humanGateVerdicts: [...(run.humanGateVerdicts ?? []), verdict],
      timeline: [
        this.timelineItem({
          type: "human",
          title: `Human gate ${input.verdict}: ${input.phase}`,
          detail: reason ?? undefined,
          terminalSessionId: run.orchestrator.sessionId ?? null,
        }),
      ],
    });
  }

  async submitRoundConfirmation(
    runId: string,
    input: SubmitOrchestratorRoundConfirmationRequest,
  ): Promise<OrchestratorRunPackage> {
    const run = await this.requireRun(runId);
    const pending = run.pendingRoundConfirmation;
    if (!pending || pending.id !== input.confirmationId) {
      throw new OrchestratorError(
        409,
        "Round confirmation does not match current pending confirmation",
      );
    }
    const reason = input.reason?.trim() || null;
    if (input.verdict === "rejected" && !reason) {
      throw new OrchestratorError(
        400,
        "Rejected round confirmation requires a reason",
      );
    }
    const nextPhase =
      input.verdict === "approved" ? pending.nextPhase : pending.fromPhase;
    const record: OrchestratorRoundConfirmation = {
      id: `round_${Date.now()}_${randomBytes(2).toString("hex")}`,
      pendingId: pending.id,
      at: new Date().toISOString(),
      fromPhase: pending.fromPhase,
      nextPhase: pending.nextPhase,
      roleId: pending.roleId,
      goalId: pending.goalId,
      verdict: input.verdict,
      reason,
    };
    const orchestratorSession = run.orchestrator.sessionId
      ? this.terminalSessionManager.getSession(run.orchestrator.sessionId)
      : null;
    if (orchestratorSession) {
      await this.promptSender.sendPromptToAgent(
        orchestratorSession,
        buildHumanPrompt(formatRoundConfirmationPrompt(record, nextPhase)),
        run.orchestrator.binding,
      );
    }
    return this.updateRun(run, {
      status: "running",
      currentPhase: nextPhase,
      pendingRoundConfirmation: null,
      roundConfirmations: [...(run.roundConfirmations ?? []), record],
      timeline: [
        this.timelineItem({
          type: "human",
          title: `Round confirmation ${input.verdict}: ${pending.goalId ?? pending.roleId ?? pending.id}`,
          detail: reason ?? undefined,
          goalId: pending.goalId,
          roleId: pending.roleId,
          terminalSessionId: run.orchestrator.sessionId ?? null,
        }),
      ],
    });
  }

  async injectPrompt(
    runId: string,
    text: string,
  ): Promise<OrchestratorRunPackage> {
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
      run.orchestrator.binding,
    );
    return this.updateRun(run, {
      status:
        run.status === "paused" || run.status === "need_human"
          ? "running"
          : run.status,
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
    if (status === "done" && !canMarkDone(run)) {
      throw new OrchestratorError(
        409,
        "Run can only be marked done from finalize phase",
      );
    }
    return this.updateRun(run, {
      status,
      ...(status === "done" ? { currentPhase: "done" as const } : {}),
      timeline: [
        this.timelineItem({
          type: "human",
          title: `Run status set to ${status}`,
          terminalSessionId: run.orchestrator.sessionId ?? null,
        }),
      ],
    });
  }

  private async handleTerminalEvent(
    event: TerminalEventEnvelope,
  ): Promise<void> {
    if (event.kind !== "completion") {
      return;
    }
    const outbox = await this.outboxResolver.resolveOutbox(event);
    if (!outbox?.runId) {
      return;
    }
    const outboxWithRunId: WorkerOutboxWithRunId = {
      ...outbox,
      runId: outbox.runId,
    };
    await this.enqueueTerminalEvent(outboxWithRunId.runId, () =>
      this.handleWorkerCompletionEvent(event, outboxWithRunId),
    );
  }

  private async enqueueTerminalEvent(
    runId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.terminalEventQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.terminalEventQueues.set(runId, next);
    try {
      await next;
    } finally {
      if (this.terminalEventQueues.get(runId) === next) {
        this.terminalEventQueues.delete(runId);
      }
    }
  }

  private async handleWorkerCompletionEvent(
    event: TerminalCompletionEvent,
    outbox: WorkerOutboxWithRunId,
  ): Promise<void> {
    const run = await this.getRun(outbox.runId);
    if (!run) {
      return;
    }
    if (run.status === "done" || run.status === "failed") {
      return;
    }
    if (event.terminalSessionId === run.orchestrator.sessionId) {
      return;
    }
    const existingGoal = outbox.goalId
      ? run.goals.find((item) => item.id === outbox.goalId)
      : null;
    const displaySummary = cleanTimelineSummary(outbox.summary);
    const goal = outbox.goalId
      ? upsertGoal(run.goals, {
          id: outbox.goalId,
          desc: displaySummary || outbox.summary,
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
        detail: displaySummary || undefined,
        goalId: outbox.goalId ?? null,
        roleId: outbox.role ?? null,
        terminalSessionId: outbox.sessionId,
      }),
    ];
    const phasePatch = advancePhaseForWorkerResult(outbox);
    const transition = phasePatch
      ? this.buildWorkerResultTransition(run, outbox, phasePatch)
      : null;
    if (transition?.timelineItems?.length) {
      nextTimeline.push(...transition.timelineItems);
    }

    if (run.status === "paused") {
      await this.updateRun(run, {
        goals: run.goals,
        ...(transition?.patch ?? {}),
        timeline: nextTimeline,
      });
      return;
    }

    const orchestratorSession = run.orchestrator.sessionId
      ? this.terminalSessionManager.getSession(run.orchestrator.sessionId)
      : null;
    if (!orchestratorSession) {
      await this.updateRun(run, {
        goals: run.goals,
        ...(transition?.patch ?? {}),
        timeline: nextTimeline,
      });
      return;
    }
    await this.promptSender.sendPromptToAgent(
      orchestratorSession,
      [buildResultPrompt(outbox), transition?.autoGatePrompt]
        .filter((item): item is string => Boolean(item))
        .join("\n\n"),
      run.orchestrator.binding,
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
    await this.updateRun(run, {
      goals: run.goals,
      ...(transition?.patch ?? {}),
      timeline: nextTimeline,
    });
  }

  private buildWorkerResultTransition(
    run: OrchestratorRunPackage,
    outbox: {
      role?: string | null;
      goalId?: string | null;
      summary: string;
    },
    phasePatch: {
      currentPhase: NonNullable<OrchestratorRunPackage["currentPhase"]>;
      status?: OrchestratorRunStatus;
    },
  ): WorkerResultTransition {
    const autoGatePhase = getAutoApprovedGatePhase(
      run,
      phasePatch.currentPhase,
    );
    if (autoGatePhase) {
      const transition = resolveHumanGateTransition({
        phase: autoGatePhase,
        verdict: "approved",
      });
      const verdict: HumanGateVerdict = {
        id: `gate_${Date.now()}_${randomBytes(2).toString("hex")}`,
        phase: autoGatePhase,
        verdict: "approved",
        reason: "Auto-approved by run option",
        at: new Date().toISOString(),
      };
      return {
        patch: {
          status: transition.status,
          currentPhase: transition.currentPhase,
          pendingRoundConfirmation: null,
          humanGateVerdicts: [...(run.humanGateVerdicts ?? []), verdict],
        },
        autoGatePrompt: formatHumanGatePrompt(verdict, transition.currentPhase),
        timelineItems: [
          this.timelineItem({
            type: "human",
            title: `Human gate auto-approved: ${autoGatePhase}`,
            detail: verdict.reason ?? undefined,
            terminalSessionId: run.orchestrator.sessionId ?? null,
          }),
        ],
      };
    }
    if (
      shouldRequireRoundConfirmation({
        run,
        nextPhase: phasePatch.currentPhase,
        nextStatus: phasePatch.status,
      })
    ) {
      return {
        patch: {
          status: "need_human",
          pendingRoundConfirmation: createPendingRoundConfirmation({
            id: `confirm_${Date.now()}_${randomBytes(2).toString("hex")}`,
            at: new Date().toISOString(),
            run,
            nextPhase: phasePatch.currentPhase,
            outbox: {
              sessionId: "",
              status: "completed",
              artifacts: [],
              error: null,
              finishedAt: new Date().toISOString(),
              ...outbox,
            },
          }),
        },
      };
    }
    return {
      patch: {
        currentPhase: phasePatch.currentPhase,
        ...(phasePatch.status ? { status: phasePatch.status } : {}),
        pendingRoundConfirmation: null,
      },
    };
  }

  private resolveControlPlaneBaseUrl(): string | null {
    return (
      this.controlPlaneBaseUrl ??
      normalizeBaseUrl(process.env.RUNWEAVE_BASE_URL)
    );
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
    patch: Partial<
      Pick<
        OrchestratorRunPackage,
        | "status"
        | "currentPhase"
        | "goals"
        | "humanInbox"
        | "humanGateVerdicts"
        | "pendingRoundConfirmation"
        | "roundConfirmations"
      >
    > & {
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

function formatHumanGatePrompt(
  verdict: HumanGateVerdict,
  nextPhase: string,
): string {
  const result =
    verdict.verdict === "approved" ? "人工门禁已通过" : "人工门禁未通过";
  return [
    `${result}: ${verdict.phase}`,
    `Next phase: ${nextPhase}`,
    verdict.reason ? `Reason: ${verdict.reason}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`,
  "g",
);
const OSC_TITLE_SEQUENCE_PATTERN = new RegExp(
  `\\]0;[^${BELL_CHAR}\\n]*(?:${BELL_CHAR}|$)`,
  "g",
);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const REVERSE_INDEX_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CHAR}M`, "g");
const TERMINAL_CONTROL_CHARS_PATTERN = new RegExp(
  `[${BELL_CHAR}${ESCAPE_CHAR}]`,
  "g",
);

function cleanTimelineSummary(value?: string | null): string {
  return cleanTimelineText(value)
    .split("\n")
    .map((line) => trimTerminalNoiseSuffix(line.trim()))
    .filter((line) => line && !isTerminalNoiseLine(line))
    .slice(0, 8)
    .join("\n")
    .trim();
}

function cleanTimelineText(value?: string | null): string {
  return (value ?? "")
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(OSC_TITLE_SEQUENCE_PATTERN, "")
    .replace(ANSI_SEQUENCE_PATTERN, "")
    .replace(REVERSE_INDEX_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_CONTROL_CHARS_PATTERN, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimTerminalNoiseSuffix(value: string): string {
  const noiseIndex = [
    value.indexOf("•Working"),
    value.indexOf("•Explored"),
    value.indexOf("›"),
  ]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return noiseIndex == null ? value : value.slice(0, noiseIndex).trim();
}

function isTerminalNoiseLine(value: string): boolean {
  const spinnerFragments =
    value.match(/(?:Working|Workin|Worki|Wor|orking|rking|king|ngg)/g)
      ?.length ?? 0;
  return (
    (spinnerFragments >= 3 && !/[\u4e00-\u9fff]/.test(value)) ||
    (/^[─│└┌┐┘├┤┬┴┼]/.test(value) && !/[\u4e00-\u9fff]/.test(value)) ||
    /^[•\s]*(?:Working|Workin|Explored|Ran)\b/.test(value) ||
    /^[─•\s]+$/.test(value) ||
    /^›/.test(value)
  );
}

function getAutoApprovedGatePhase(
  run: OrchestratorRunPackage,
  phase: OrchestratorRunPackage["currentPhase"],
): HumanGatePhase | null {
  if (phase === "human_plan_approval" && run.options?.autoApprovePlanGate) {
    return phase;
  }
  if (phase === "human_verify" && run.options?.autoApproveVerifyGate) {
    return phase;
  }
  return null;
}

function formatRoundConfirmationPrompt(
  confirmation: OrchestratorRoundConfirmation,
  nextPhase: string,
): string {
  const result =
    confirmation.verdict === "approved"
      ? "人工轮次确认已通过"
      : "人工轮次确认未通过";
  return [
    `${result}: ${confirmation.goalId ?? confirmation.roleId ?? confirmation.pendingId}`,
    `Next phase: ${nextPhase}`,
    confirmation.reason ? `Reason: ${confirmation.reason}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
