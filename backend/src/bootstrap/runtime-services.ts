import { settingText, configuration } from "@runweave/config-node";
import type { RuntimeServices } from "./runtime-services-contract";
export type { RuntimeServices } from "./runtime-services-contract";
import { createKnowledgeInbox } from "./knowledge-inbox";
import { createEvolutionStorage } from "./evolution-storage";
import { prepareEvolutionRepositoryMigration } from "./evolution-migration";
import { LocalBrowserService } from "../browser-local/service";
import { resolveTmuxShutdownPolicy } from "./tmux-shutdown-policy";
import {
  createDeviceMonitor,
} from "../device-monitor/bootstrap";
import { MobileLoginService } from "../auth/mobile-login";
import path from "node:path";
import { createExperienceLearning } from "../experience/bootstrap";
import crypto from "node:crypto";
import { LowDbAuthStore } from "../auth/lowdb-store";
import { loadAuthConfig } from "../auth/config";
import { AuthService } from "../auth/service";
import { AgentTeamService } from "../agent-team/service";
import { AgentTeamModelConfigStore } from "../agent-team/runtime/model-config-store";
import { AgentTeamModelSettingsService } from "../agent-team/model-catalog/service";
import { ActivityRuntime } from "../activity/runtime";
import { ResourceScope } from "./resource-scope";
import { logger } from "../logging/index";
import { LowDbTerminalQuickInputStore } from "../terminal/quick-input/lowdb-store";
import { TerminalQuickInputService } from "../terminal/quick-input/service";
import { loadOrCreateHookToken } from "../terminal/application/hook-token";
import { createTerminalSnapshotShares } from "./terminal-snapshot-shares";
import { PtyService } from "../terminal/runtime/pty-service";
import { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import { TmuxLifecycleCoordinator } from "../terminal/tmux/lifecycle-coordinator";
import { TmuxOutputWatcher } from "../terminal/tmux/output-watcher";
import { TmuxService } from "../terminal/tmux/service";
import { TerminalSessionManager } from "../terminal/manager/manager";
import { RuntimeStatusWorkspaceServiceManager } from "../runtime-status/workspace-service-manager";
import { TerminalCompletionEventService } from "../terminal/completion/event-service";
import { TerminalEventService } from "../terminal/state/terminal-event-service";
import { TerminalStateService } from "../terminal/state/terminal-state-service";
import { TerminalStateStore } from "../terminal/state/terminal-state-store";
import { LowDbTerminalSessionStore } from "../terminal/store/lowdb-store";
import { logOrphanedTmuxSessions } from "../terminal/tmux/orphan-scan";
import { syncExistingTmuxSessionEnvironments } from "../terminal/tmux/session-environment-sync";
import {
  resolveEvolutionStoragePaths,
  resolveStoragePaths,
} from "../utils/path";
import { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { WorkHistoryService } from "../work-history/work-history-service";
import { AttentionService } from "../attention/attention-service";
import { EvolutionAnalysisOrchestrator } from "../evolution/analysis/orchestrator";
import { EvolutionContextPackBuilder } from "../evolution/context-pack";

import { EvolutionEvidenceReconciler } from "../evolution/knowledge/evidence-reconciler";

import { EvolutionRuntime } from "../evolution/runtime";
import { DefaultEvolutionSupplementalSourceReader } from "../evolution/supplemental-sources";
import { RaceRecordStore } from "../race/race-record-store";
import { RaceService } from "../race/race-service";
import { BackendRuntimeStatusService } from "../runtime-status/service";
import { createScheduledTasks } from "./scheduled-tasks";
import { ScheduledTaskAlerts } from "../device-monitor/scheduled-task-alerts";
import {
  resolveDefaultTmuxSocketPath,
} from "./tmux-paths";


function resolveTerminalHookToken(
  env: NodeJS.ProcessEnv,
  tokenFilePath: string,
): string {
  const existing = env.RUNWEAVE_HOOK_TOKEN?.trim();
  return existing || loadOrCreateHookToken(tokenFilePath);
}

function shouldScanTmuxOrphans(): boolean {
  return (
    settingText("terminal.tmux.scanOrphansOnStart")?.trim().toLowerCase() === "true" ||
    settingText("terminal.tmux.cleanupOrphans")?.trim().toLowerCase() === "true"
  );
}

export async function createRuntimeServices(
  serviceInstanceId?: string,
): Promise<RuntimeServices> {
  const resources = new ResourceScope();
  try {
    return await assembleRuntimeServices(resources, serviceInstanceId);
  } catch (error) {
    try {
      await resources.dispose();
    } catch (cleanupError) {
      logger.error("backend.start.cleanup.failed", { error: cleanupError });
    }
    throw error;
  }
}

async function assembleRuntimeServices(
  resources: ResourceScope,
  serviceInstanceId?: string,
): Promise<RuntimeServices> {
  const storagePaths = resolveStoragePaths();
  const evolutionPaths = resolveEvolutionStoragePaths();
  await prepareEvolutionRepositoryMigration();
  const runtimeChannel = configuration().context.kind;
  const tmuxShutdownPolicy = resolveTmuxShutdownPolicy(runtimeChannel);
  const activity = await ActivityRuntime.create({
    env: process.env,
    browserProfileDir: storagePaths.browserProfileDir,
    runtimeChannel,
  });
  resources.defer("activity", () => activity.dispose());
  const {
    store: activityStore,
    recorder: activityRecorder,
    queryService: activityQueryService,
    eventFactory: activityEventFactory,
    instanceId: activityInstanceId,
  } = activity;
  const { experienceService, experienceLearning } = createExperienceLearning(
    activityStore,
    runtimeChannel,
  );
  resources.defer("experience-learning", () => experienceLearning.dispose());
  const terminalActivity = {
    recorder: activityRecorder,
    eventFactory: activityEventFactory,
  };
  const authConfig = loadAuthConfig();
  const authStore = new LowDbAuthStore(storagePaths.authStoreFile);
  resources.defer("auth-store", () => authStore.dispose());
  const persistedAuth = await authStore.initialize({
    username: authConfig.username,
    password: authConfig.password,
    jwtSecret: authConfig.jwtSecret,
    updatedAt: new Date().toISOString(),
    refreshSessions: [],
  });
  const authService = new AuthService(
    {
      ...authConfig,
      username: persistedAuth.username,
      password: persistedAuth.password,
      jwtSecret: persistedAuth.jwtSecret,
      initialRefreshSessions: persistedAuth.refreshSessions,
    },
    authStore,
  );
  const terminalSessionStore = new LowDbTerminalSessionStore(
    storagePaths.terminalSessionStoreFile,
  );
  const terminalQuickInputStore = new LowDbTerminalQuickInputStore(
    storagePaths.terminalQuickInputStoreFile,
  );
  resources.defer("terminal-quick-input-store", () =>
    terminalQuickInputStore.dispose(),
  );
  await terminalQuickInputStore.initialize();
  const agentTeamModelConfigStore = new AgentTeamModelConfigStore(
    storagePaths.agentTeamModelStoreFile,
  );
  resources.defer("agent-team-model-config", () =>
    agentTeamModelConfigStore.dispose(),
  );
  await agentTeamModelConfigStore.initialize();
  const agentTeamModelSettingsService = new AgentTeamModelSettingsService(
    agentTeamModelConfigStore,
    process.env,
  );
  const terminalQuickInputService = new TerminalQuickInputService(
    terminalQuickInputStore,
  );
  const terminalEventService = new TerminalEventService();
  let terminalStateService: TerminalStateService | null = null;
  const terminalSessionManager = new TerminalSessionManager(
    terminalSessionStore,
    {
      onBell: ({ terminalSessionId, projectId, count }) => {
        terminalEventService.record({
          kind: "terminal_bell",
          terminalSessionId,
          projectId,
          payload: { count },
        });
      },
      onMetadataChanged: ({
        terminalSessionId,
        projectId,
        session,
        previous,
        next,
      }) => {
        terminalEventService.record({
          kind: "terminal_session_metadata_changed",
          terminalSessionId,
          projectId,
          payload: { previous, next },
        });
        terminalStateService?.setShellActiveCommand(
          terminalSessionId,
          session,
          {
            projectId,
            reason: session.status === "exited" ? "exit" : "metadata",
          },
        );
      },
    },
  );
  resources.defer("terminal-session-manager", () =>
    terminalSessionManager.dispose(),
  );
  const terminalCompletionEventService = new TerminalCompletionEventService(
    terminalEventService,
    terminalSessionManager,
    (event) => experienceLearning.enqueue(event),
  );
  const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
  const tmuxLifecycleCoordinator = new TmuxLifecycleCoordinator();
  process.env.RUNWEAVE_HOOK_TOKEN = resolveTerminalHookToken(
    process.env,
    path.join(storagePaths.browserProfileDir, "runweave-hook-token"),
  );
  process.env.RUNWEAVE_HOOK_DEBUG_LOG ??= path.join(
    storagePaths.browserProfileDir,
    "logs",
    "hook-bridge-debug.jsonl",
  );
  const ptyService = new PtyService();
  const tmuxService = new TmuxService({
    socketPath:
      resolveDefaultTmuxSocketPath(
        storagePaths.browserProfileDir,
        runtimeChannel,
      ),
    env: process.env,
  });
  const tmuxSocketPathsToCleanOnShutdown = tmuxShutdownPolicy === "preserve"
    ? []
    : [
        tmuxService.socketPath,
      ];
  for (const socketPath of new Set(tmuxSocketPathsToCleanOnShutdown)) {
    resources.defer("tmux-server", () =>
      tmuxService.killServer(socketPath).then(() => undefined),
    );
  }
  resources.defer("terminal-runtimes", () =>
    terminalRuntimeRegistry.disposeAll(),
  );
  const tmuxOutputWatcher = new TmuxOutputWatcher({
    outputDir: path.join(
      path.dirname(storagePaths.terminalSessionStoreFile),
      "tmux-output",
    ),
    terminalSessionManager,
    tmuxService,
    tmuxLifecycleCoordinator,
  });
  resources.defer("tmux-output-watcher", () => tmuxOutputWatcher.dispose());
  await terminalSessionManager.initialize();
  const terminalSnapshotShareService = createTerminalSnapshotShares(resources, terminalSessionManager, tmuxService);
  const workspaceServiceManager = new RuntimeStatusWorkspaceServiceManager(
    terminalSessionManager,
  );
  resources.defer("workspace-services", () =>
    workspaceServiceManager.dispose(),
  );
  const environmentSync = syncExistingTmuxSessionEnvironments(
    terminalSessionManager,
    tmuxService,
  )
    .then((failures) => {
      for (const failure of failures) {
        logger.warn("terminal.tmux.environment-sync.startup.failed", {
          message: "Failed to refresh terminal tmux environment during startup",
          terminalSessionId: failure.terminalSessionId,
          socketPath: failure.socketPath,
          error: failure.error,
        });
      }
    })
    .catch((error) => {
      logger.warn("terminal.tmux.environment-sync.startup.failed", {
        message: "Failed to refresh terminal tmux environments during startup",
        error,
      });
    });
  resources.defer("tmux-environment-recovery", () => environmentSync);
  terminalStateService = new TerminalStateService(
    new TerminalStateStore(
      terminalSessionManager
        .listSessions()
        .flatMap((session) =>
          session.terminalState
            ? [[session.id, session.terminalState] as const]
            : [],
        ),
    ),
    terminalEventService,
    (terminalSessionId, terminalState) => {
      void terminalSessionManager.updateSessionTerminalState(
        terminalSessionId,
        terminalState,
      );
    },
  );
  const scheduledTasks = await createScheduledTasks(resources, {
    browserProfileDir: storagePaths.browserProfileDir,
    terminalSessionManager,
    terminalRuntimeRegistry,
    ptyService,
    tmuxService,
    tmuxOutputWatcher,
    terminalEventService,
    terminalStateService,
    terminalActivity,
  });
  if (shouldScanTmuxOrphans()) {
    await logOrphanedTmuxSessions(terminalSessionManager, tmuxService);
  }
  const outputRecovery = tmuxOutputWatcher
    .watchExistingSessions()
    .catch((error) => {
      logger.warn("terminal.tmux.output-watch.startup.failed", {
        message: "Failed to recover tmux output watchers during startup",
        error,
      });
    });
  resources.defer("tmux-output-recovery", () => outputRecovery);
  const {
    evolutionActivationStore,
    evolutionAnalysisStore,
    evolutionFoundationStore,
    evolutionContextPackStore,
    evolutionProviderAvailability,
    evolutionService,
    evolutionToolTokenRegistry,
    evolutionMemoryProvider,
    evolutionOutcomeObserver,
  } = await createEvolutionStorage(
    evolutionPaths,
    resources,
    terminalSessionManager,
    activityQueryService,
  );
  const knowledgeInboxService = createKnowledgeInbox(resources, {
    evolutionService, evolutionAnalysisStore, evolutionFoundationStore,
    activityQueryService, experienceService, terminalSessionManager,
  });
  const agentTeamService = new AgentTeamService({
    terminalSessionManager,
    terminalEventService,
    ptyService,
    runtimeRegistry: terminalRuntimeRegistry,
    terminalStateService,
    tmuxService,
    tmuxOutputWatcher,
    activity: terminalActivity,
    backendInstanceId: crypto.randomUUID(),
    evolutionMemoryProvider,
    evolutionOutcomeObserver,
    modelSettingsService: agentTeamModelSettingsService,
  });
  resources.defer("agent-team", () => agentTeamService.dispose());
  const raceService = new RaceService({
    terminalSessionManager,
    terminalEventService,
    ptyService,
    runtimeRegistry: terminalRuntimeRegistry,
    terminalStateService,
    tmuxService,
    tmuxOutputWatcher,
    store: new RaceRecordStore(
      path.join(storagePaths.browserProfileDir, "race", "current.json"),
    ),
  });
  await raceService.initialize();
  const appServerHistoryGateway = new AppServerHistoryGateway();
  const workHistoryService = new WorkHistoryService(
    terminalSessionManager,
    activityQueryService,
    appServerHistoryGateway,
    agentTeamService,
  );
  const evolutionOrchestrator =
    evolutionFoundationStore &&
    evolutionAnalysisStore &&
    evolutionContextPackStore &&
    activityStore
      ? new EvolutionAnalysisOrchestrator(
          evolutionFoundationStore,
          evolutionAnalysisStore,
          new EvolutionContextPackBuilder(
            activityQueryService,
            evolutionContextPackStore,
            undefined,
            new DefaultEvolutionSupplementalSourceReader(
              appServerHistoryGateway,
              agentTeamService,
              (learningScopeId) =>
                terminalSessionManager.getProjectContext(learningScopeId)
                  ?.path ??
                terminalSessionManager.getProject(learningScopeId)?.path ??
                null,
            ),
          ),
          evolutionToolTokenRegistry,
          evolutionProviderAvailability,
          evolutionPaths.temporaryDir,
        )
      : null;
  const evolutionRuntime = new EvolutionRuntime(
    evolutionFoundationStore,
    evolutionService,
    evolutionOrchestrator,
    (error) => {
      logger.warn("evolution.maintenance.failed", {
        component: "evolution",
        message: "Evolution recovery or scheduler pass failed",
        error,
      });
    },
    evolutionAnalysisStore && activityStore
      ? new EvolutionEvidenceReconciler(
          activityQueryService,
          evolutionAnalysisStore,
        )
      : null,
  );
  resources.defer("evolution-runtime", () => evolutionRuntime.dispose());
  const attentionService = new AttentionService(
    terminalSessionManager,
    terminalCompletionEventService,
    agentTeamService,
    terminalStateService,
  );

  const runtimeStatus = new BackendRuntimeStatusService(
    serviceInstanceId ?? activityInstanceId,
    {
      activityStoreAvailable: activityStore !== null,
      agentTeamService,
      evolutionRuntime,
      workspaceServiceManager,
    },
  );
  resources.defer("runtime-status", () => runtimeStatus.dispose());
  const deviceMonitoring = await createDeviceMonitor(
    storagePaths.browserProfileDir,
    authService,
  );
  resources.defer("push-configuration", deviceMonitoring.disposeConfiguration);
  resources.defer("device-monitor", () =>
    deviceMonitoring.deviceMonitor?.dispose(),
  );
  resources.defer("battery-alerts", () =>
    deviceMonitoring.batteryAlerts?.dispose(),
  );
  const taskAlerts =
    scheduledTasks.store && deviceMonitoring.batteryAlerts
      ? new ScheduledTaskAlerts(
          scheduledTasks.store,
          deviceMonitoring.batteryAlerts.subscriptions,
        )
      : null;
  if (taskAlerts)
    resources.defer("scheduled-task-alerts", () => taskAlerts.dispose());
  const mobileLoginService = new MobileLoginService(authService);
  resources.defer("mobile-login", () => mobileLoginService.dispose());
  const localBrowserService = new LocalBrowserService((authId, terminalId) =>
    Boolean(
      authService.getActiveAppSession(authId) &&
      terminalSessionManager.getSession(terminalId),
    ),
  );
  resources.defer("local-browser", () => localBrowserService.dispose());
  let disposed = false;
  const services: RuntimeServices = {
    ...deviceMonitoring,
    start: (controlPlaneBaseUrl) => {
      if (disposed) return;
      activity.start();
      agentTeamService.initialize();
      evolutionRuntime.start(controlPlaneBaseUrl);
      experienceLearning.start();
      scheduledTasks.runtime?.start();
      taskAlerts?.start();
    },
    dispose: () => {
      disposed = true;
      return resources.dispose();
    },
    runtimeStatus,
    activityStore,
    activityRecorder,
    activityQueryService,
    activityEventFactory,
    terminalActivity,
    authStore,
    authService,
    mobileLoginService,
    localBrowserService,
    authCookieName: authConfig.refreshCookieName,
    authSecureCookies: authConfig.secureCookies,
    terminalSessionManager,
    terminalSnapshotShareService,
    workspaceServiceManager,
    terminalQuickInputStore,
    terminalQuickInputService,
    terminalStateService,
    agentTeamService,
    agentTeamModelConfigStore,
    raceService,
    appServerHistoryGateway,
    workHistoryService,
    terminalEventService,
    terminalCompletionEventService,
    attentionService,
    terminalRuntimeRegistry,
    tmuxLifecycleCoordinator,
    ptyService,
    tmuxService,
    tmuxOutputWatcher,
    tmuxSocketPathsToCleanOnShutdown,
    evolutionActivationStore,
    evolutionAnalysisStore,
    evolutionContextPackStore,
    evolutionToolTokenRegistry,
    evolutionRuntime,
    evolutionService,
    knowledgeInboxService,
    experienceService,
    experienceLearning,
    scheduledTaskService: scheduledTasks.service,
  };
  return services;
}
