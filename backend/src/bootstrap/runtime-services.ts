import { createDeviceMonitor, type DeviceMonitoringRuntime } from "../device-monitor/bootstrap";
import { MobileLoginService } from "../auth/mobile-login";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AuthStore } from "../auth/store";
import { LowDbAuthStore } from "../auth/lowdb-store";
import { loadAuthConfig } from "../auth/config";
import { AuthService } from "../auth/service";
import { AgentTeamService } from "../agent-team/service";
import { AgentTeamModelConfigStore } from "../agent-team/runtime/model-config-store";
import { AgentTeamModelSettingsService } from "../agent-team/model-catalog/service";
import type { ActivityEventFactory } from "../activity/recording/event-factory";
import type { ActivityQueryService } from "../activity/database/service";
import type { ActivityRecorder } from "../activity/recording/recorder";
import type { ActivityStore } from "../activity/recording/store";
import { ActivityRuntime } from "../activity/runtime";
import { ResourceScope } from "./resource-scope";
import { logger } from "../logging/index";
import { LowDbTerminalQuickInputStore } from "../terminal/quick-input/lowdb-store";
import { TerminalQuickInputService } from "../terminal/quick-input/service";
import { loadOrCreateHookToken } from "../terminal/application/hook-token";
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
import type { TerminalActivityDependencies } from "../terminal/runtime/activity-events";
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
import {
  InMemoryEvolutionActivationStore,
  type EvolutionActivationStore,
} from "../evolution/activation-store";
import type { EvolutionAnalysisStore } from "../evolution/analysis-store";
import { EvolutionAnalysisOrchestrator } from "../evolution/analysis/orchestrator";
import { EvolutionContextPackBuilder } from "../evolution/context-pack";
import { DefaultEvolutionMemoryProvider } from "../evolution/injection/memory-provider";
import { EvolutionOutcomeObserver } from "../evolution/injection/outcome-observer";
import { EvolutionEvidenceReconciler } from "../evolution/knowledge/evidence-reconciler";
import { StructuredEvolutionMemorySelector } from "../evolution/knowledge/retrieval";
import type { EvolutionFoundationStore } from "../evolution/foundation-store";
import type { EvolutionContextPackStore } from "../evolution/context-pack-store";
import { EvolutionRuntime } from "../evolution/runtime";
import { EvolutionService } from "../evolution/service";
import { SqliteEvolutionActivationStore } from "../evolution/storage/store";
import { DefaultEvolutionSupplementalSourceReader } from "../evolution/supplemental-sources";
import { EvolutionToolTokenRegistry } from "../evolution/tools/token-registry";
import { EvolutionProviderAvailabilityService } from "../evolution/providers/availability";
import { RaceRecordStore } from "../race/race-record-store";
import { RaceService } from "../race/race-service";
import { BackendRuntimeStatusService } from "../runtime-status/service";

export interface RuntimeServices extends DeviceMonitoringRuntime {
  start(controlPlaneBaseUrl: string): void;
  dispose(): Promise<void>;
  runtimeStatus: BackendRuntimeStatusService;
  activityStore: ActivityStore | null;
  activityRecorder: ActivityRecorder;
  activityQueryService: ActivityQueryService;
  activityEventFactory: ActivityEventFactory;
  terminalActivity: TerminalActivityDependencies;
  authStore: AuthStore;
  authService: AuthService;
  mobileLoginService: MobileLoginService;
  authCookieName: string;
  authSecureCookies: boolean;
  terminalSessionManager: TerminalSessionManager;
  workspaceServiceManager: RuntimeStatusWorkspaceServiceManager;
  terminalQuickInputStore: LowDbTerminalQuickInputStore;
  terminalQuickInputService: TerminalQuickInputService;
  terminalStateService: TerminalStateService;
  agentTeamService: AgentTeamService;
  agentTeamModelConfigStore: AgentTeamModelConfigStore;
  raceService: RaceService;
  appServerHistoryGateway: AppServerHistoryGateway;
  workHistoryService: WorkHistoryService;
  terminalEventService: TerminalEventService;
  terminalCompletionEventService: TerminalCompletionEventService;
  attentionService: AttentionService;
  terminalRuntimeRegistry: TerminalRuntimeRegistry;
  tmuxLifecycleCoordinator: TmuxLifecycleCoordinator;
  ptyService: PtyService;
  tmuxService: TmuxService;
  tmuxOutputWatcher: TmuxOutputWatcher;
  tmuxSocketPathsToCleanOnShutdown: readonly string[];
  evolutionActivationStore: EvolutionActivationStore;
  evolutionAnalysisStore: EvolutionAnalysisStore | null;
  evolutionContextPackStore: EvolutionContextPackStore | null;
  evolutionToolTokenRegistry: EvolutionToolTokenRegistry;
  evolutionRuntime: EvolutionRuntime;
  evolutionService: EvolutionService;
}

function resolveTerminalHookToken(
  env: NodeJS.ProcessEnv,
  tokenFilePath: string,
): string {
  const existing = env.RUNWEAVE_HOOK_TOKEN?.trim();
  return existing || loadOrCreateHookToken(tokenFilePath);
}

function shouldScanTmuxOrphans(env: NodeJS.ProcessEnv): boolean {
  return (
    env.TERMINAL_TMUX_SCAN_ORPHANS_ON_START?.trim().toLowerCase() === "true" ||
    env.TERMINAL_TMUX_CLEANUP_ORPHANS?.trim().toLowerCase() === "true"
  );
}

function resolveTmuxProfileId(browserProfileDir: string): string {
  return createHash("sha256")
    .update(browserProfileDir)
    .digest("hex")
    .slice(0, 12);
}

function resolvePersistentTmuxSocketPath(browserProfileDir: string): string {
  return path.join(
    os.homedir(),
    ".runweave",
    "tmux",
    resolveTmuxProfileId(browserProfileDir),
    "tmux.sock",
  );
}

function resolveDefaultTmuxSocketPath(
  browserProfileDir: string,
  runtimeChannel: "stable" | "beta" | "dev",
): string {
  return shouldPreserveTmuxOnShutdown(runtimeChannel)
    ? resolvePersistentTmuxSocketPath(browserProfileDir)
    : path.join(
        os.tmpdir(),
        `rw-tmux-${resolveTmuxProfileId(browserProfileDir)}`,
        "tmux.sock",
      );
}

function shouldPreserveTmuxOnShutdown(
  runtimeChannel: "stable" | "beta" | "dev",
): boolean {
  return runtimeChannel === "stable";
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
  const storagePaths = resolveStoragePaths(process.env);
  const evolutionPaths = resolveEvolutionStoragePaths(process.env);
  const runtimeChannel =
    process.env.RUNWEAVE_DESKTOP_CHANNEL === "stable" ||
    process.env.RUNWEAVE_DESKTOP_CHANNEL === "beta"
      ? process.env.RUNWEAVE_DESKTOP_CHANNEL
      : "dev";
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
  const terminalActivity = { recorder: activityRecorder, eventFactory: activityEventFactory };
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
  resources.defer("terminal-quick-input-store", () => terminalQuickInputStore.dispose());
  await terminalQuickInputStore.initialize();
  const agentTeamModelConfigStore = new AgentTeamModelConfigStore(
    storagePaths.agentTeamModelStoreFile,
  );
  resources.defer("agent-team-model-config", () => agentTeamModelConfigStore.dispose());
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
  resources.defer("terminal-session-manager", () => terminalSessionManager.dispose());
  const terminalCompletionEventService = new TerminalCompletionEventService(
    terminalEventService,
    terminalSessionManager,
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
      process.env.TERMINAL_TMUX_SOCKET_PATH ??
      resolveDefaultTmuxSocketPath(
        storagePaths.browserProfileDir,
        runtimeChannel,
      ),
    env: process.env,
  });
  const tmuxSocketPathsToCleanOnShutdown = shouldPreserveTmuxOnShutdown(
    runtimeChannel,
  )
    ? []
    : [
        tmuxService.socketPath,
        ...(runtimeChannel === "beta"
          ? [resolvePersistentTmuxSocketPath(storagePaths.browserProfileDir)]
          : []),
      ];
  for (const socketPath of new Set(tmuxSocketPathsToCleanOnShutdown)) {
    resources.defer("tmux-server", () => tmuxService.killServer(socketPath).then(() => undefined));
  }
  resources.defer("terminal-runtimes", () => terminalRuntimeRegistry.disposeAll());
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
  const workspaceServiceManager = new RuntimeStatusWorkspaceServiceManager(
    terminalSessionManager,
  );
  resources.defer("workspace-services", () => workspaceServiceManager.dispose());
  const environmentSync = syncExistingTmuxSessionEnvironments(terminalSessionManager, tmuxService)
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
  if (shouldScanTmuxOrphans(process.env)) {
    await logOrphanedTmuxSessions(terminalSessionManager, tmuxService);
  }
  const outputRecovery = tmuxOutputWatcher.watchExistingSessions().catch((error) => {
    logger.warn("terminal.tmux.output-watch.startup.failed", {
      message: "Failed to recover tmux output watchers during startup",
      error,
    });
  });
  resources.defer("tmux-output-recovery", () => outputRecovery);
  let evolutionActivationStore: EvolutionActivationStore;
  let evolutionAnalysisStore: EvolutionAnalysisStore | null = null;
  let evolutionFoundationStore: EvolutionFoundationStore | null = null;
  let evolutionContextPackStore: EvolutionContextPackStore | null = null;
  try {
    const persistentEvolutionStore =
      await SqliteEvolutionActivationStore.create({
        databasePath: evolutionPaths.learningDatabaseFile,
        env: process.env,
      });
    evolutionActivationStore = persistentEvolutionStore;
    evolutionAnalysisStore = persistentEvolutionStore;
    evolutionFoundationStore = persistentEvolutionStore;
    evolutionContextPackStore = persistentEvolutionStore;
  } catch (error) {
    logger.warn("evolution.initialize.failed", {
      component: "evolution",
      message:
        "Persistent Evolution activation is unavailable; Backend continues with disabled in-memory policy",
      error,
    });
    evolutionActivationStore = new InMemoryEvolutionActivationStore();
  }
  resources.defer("evolution-store", () => evolutionActivationStore.close());
  const evolutionProviderAvailability =
    new EvolutionProviderAvailabilityService();
  const evolutionService = new EvolutionService(
    evolutionFoundationStore,
    undefined,
    evolutionProviderAvailability,
    evolutionAnalysisStore,
    evolutionContextPackStore,
    evolutionActivationStore,
  );
  const evolutionToolTokenRegistry = new EvolutionToolTokenRegistry();
  resources.defer("evolution-tool-tokens", () => evolutionToolTokenRegistry.clear());
  const evolutionMemoryProvider = new DefaultEvolutionMemoryProvider(
    evolutionActivationStore,
    new StructuredEvolutionMemorySelector(),
  );
  const evolutionOutcomeObserver = new EvolutionOutcomeObserver(
    evolutionActivationStore,
  );
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
  const deviceMonitoring = await createDeviceMonitor(storagePaths.browserProfileDir, authService);
  resources.defer("device-monitor", () => deviceMonitoring.deviceMonitor?.dispose());
  resources.defer("battery-alerts", () => deviceMonitoring.batteryAlerts?.dispose());
  const mobileLoginService = new MobileLoginService(authService);
  resources.defer("mobile-login", () => mobileLoginService.dispose());
  let disposed = false;
  const services: RuntimeServices = {
    ...deviceMonitoring,
    start: (controlPlaneBaseUrl) => {
      if (disposed) return;
      activity.start();
      agentTeamService.initialize();
      evolutionRuntime.start(controlPlaneBaseUrl);
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
    authCookieName: authConfig.refreshCookieName,
    authSecureCookies: authConfig.secureCookies,
    terminalSessionManager,
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
  };
  return services;
}
