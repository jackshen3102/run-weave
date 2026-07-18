import { randomUUID } from "node:crypto";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import { isTerminalChildProjectIdLike } from "@runweave/shared/terminal/project-context";
import type { TerminalSessionManager } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TerminalEventService } from "../terminal/terminal-event-service";
import type { TerminalStateService } from "../terminal/terminal-state-service";
import type { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import type { TmuxService } from "../terminal/tmux-service";
import { logger } from "../logging";
import { AgentTeamError } from "./errors";
import { AgentTeamOutboxResolver } from "./outbox-resolver";
import { AgentTeamPromptSender } from "./prompt-sender";
import { AgentTeamReviewCheckpointGit } from "./review-checkpoint-git";
import { AgentTeamPaths } from "./storage/agent-team-paths";
import { AgentTeamOutboxHistoryStore } from "./storage/outbox-history-store";
import { AgentTeamRunStore } from "./storage/run-store";
import { AgentTeamAgentLaunchService } from "./agent-launch";
import type { AgentTeamServiceOptions } from "./service-types";
import { recordAgentTeamRunTransition } from "./activity-events";
import {
  resolveAgentTeamEnvironmentFixtureScope,
  type AgentTeamEnvironmentFixtureScope,
} from "./fixture-scope";

export const agentTeamLogger = logger.child({
  component: "agent-team-service",
});

export class AgentTeamServiceContext {
  protected readonly terminalSessionManager: TerminalSessionManager;
  protected readonly terminalEventService: TerminalEventService;
  protected readonly ptyService: PtyService;
  protected readonly runtimeRegistry: TerminalRuntimeRegistry;
  protected readonly terminalStateService: TerminalStateService;
  protected readonly tmuxService?: TmuxService;
  protected readonly tmuxOutputWatcher?: TmuxOutputWatcher;
  protected readonly paths: AgentTeamPaths;
  protected readonly runStore: AgentTeamRunStore;
  protected readonly promptSender: AgentTeamPromptSender;
  protected readonly agentLaunch: AgentTeamAgentLaunchService;
  protected readonly outboxResolver: AgentTeamOutboxResolver;
  protected readonly outboxHistoryStore: AgentTeamOutboxHistoryStore;
  protected readonly reviewCheckpointGit: AgentTeamReviewCheckpointGit;
  protected readonly backendInstanceId: string;
  protected readonly environmentFixtureScope: AgentTeamEnvironmentFixtureScope | null;
  protected readonly runtimeEnv: NodeJS.ProcessEnv;
  protected readonly eventQueues = new Map<string, Promise<unknown>>();
  protected readonly pendingCompletionRounds = new Map<string, number>();
  protected recheckWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentTeamServiceOptions) {
    this.terminalSessionManager = options.terminalSessionManager;
    this.terminalEventService = options.terminalEventService;
    this.ptyService = options.ptyService;
    this.runtimeRegistry = options.runtimeRegistry;
    this.terminalStateService = options.terminalStateService;
    this.tmuxService = options.tmuxService;
    this.tmuxOutputWatcher = options.tmuxOutputWatcher;
    this.backendInstanceId = options.backendInstanceId ?? randomUUID();
    this.runtimeEnv = options.env ?? process.env;
    this.environmentFixtureScope = resolveAgentTeamEnvironmentFixtureScope(
      this.runtimeEnv,
    );
    this.paths = new AgentTeamPaths(
      this.terminalSessionManager,
      options.cwd ?? process.cwd(),
    );
    this.runStore = new AgentTeamRunStore(
      this.terminalSessionManager,
      this.paths,
      (previous, current) =>
        recordAgentTeamRunTransition(options.activity, previous, current),
    );
    this.promptSender = new AgentTeamPromptSender({
      terminalSessionManager: this.terminalSessionManager,
      ptyService: this.ptyService,
      runtimeRegistry: this.runtimeRegistry,
      terminalStateService: this.terminalStateService,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
    });
    this.agentLaunch = new AgentTeamAgentLaunchService({
      terminalSessionManager: this.terminalSessionManager,
      ptyService: this.ptyService,
      runtimeRegistry: this.runtimeRegistry,
      terminalStateService: this.terminalStateService,
      tmuxService: this.tmuxService,
      tmuxOutputWatcher: this.tmuxOutputWatcher,
    });
    this.outboxResolver = new AgentTeamOutboxResolver(this.paths);
    this.outboxHistoryStore = new AgentTeamOutboxHistoryStore(this.paths);
    this.reviewCheckpointGit = new AgentTeamReviewCheckpointGit();
  }

  async listRuns(projectId: string): Promise<AgentTeamRun[]> {
    this.assertReadableProjectRoot(projectId);
    return this.runStore.listRuns(projectId);
  }

  private assertReadableProjectRoot(projectId: string): void {
    if (
      isTerminalChildProjectIdLike(projectId) &&
      !this.terminalSessionManager.getProject(projectId)?.path
    ) {
      throw new AgentTeamError(
        409,
        "当前项目目录不可用，无法读取 Agent Team 任务",
      );
    }
  }

  async getRun(runId: string): Promise<AgentTeamRun | null> {
    return this.runStore.getRun(runId);
  }

  async getRunByTerminalSession(
    projectId: string,
    terminalSessionId: string,
  ): Promise<AgentTeamRun | null> {
    this.assertReadableProjectRoot(projectId);
    return this.runStore.getRunByTerminalSession(projectId, terminalSessionId);
  }
}
