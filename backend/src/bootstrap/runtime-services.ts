import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AuthStore } from "../auth/store";
import { LowDbAuthStore } from "../auth/lowdb-store";
import { loadAuthConfig } from "../auth/config";
import { AuthService } from "../auth/service";
import type { AppServerEventConsumerHandle } from "../app-server/event-consumer";
import { AgentTeamService } from "../agent-team/service";
import { ActivityEventFactory } from "../activity/event-factory";
import { ActivityQueryService } from "../activity/query-service";
import { ActivityRecorder } from "../activity/activity-recorder";
import { ActivityStore } from "../activity/activity-store";
import { logger } from "../logging";
import { LowDbTerminalQuickInputStore } from "../terminal/quick-input-lowdb-store";
import { TerminalQuickInputService } from "../terminal/quick-input-service";
import { loadOrCreateHookToken } from "../terminal/hook-token";
import { PtyService } from "../terminal/pty-service";
import { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { TmuxLifecycleCoordinator } from "../terminal/tmux-lifecycle-coordinator";
import { TmuxOutputWatcher } from "../terminal/tmux-output-watcher";
import { TmuxService } from "../terminal/tmux-service";
import { TerminalSessionManager } from "../terminal/manager";
import { TerminalCompletionEventService } from "../terminal/completion-event-service";
import { TerminalEventService } from "../terminal/terminal-event-service";
import { TerminalStateService } from "../terminal/terminal-state-service";
import { TerminalStateStore } from "../terminal/terminal-state-store";
import type { TerminalActivityDependencies } from "../terminal/activity-events";
import { LowDbTerminalSessionStore } from "../terminal/lowdb-store";
import { logOrphanedTmuxSessions } from "../terminal/tmux-orphan-scan";
import { syncExistingTmuxSessionEnvironments } from "../terminal/runtime-launcher";
import {
  resolveActivityStoragePaths,
  resolveStoragePaths,
} from "../utils/path";
import { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import { WorkHistoryService } from "../work-history/work-history-service";
import { AttentionService } from "../attention/attention-service";

export interface RuntimeServices {
  activityStore: ActivityStore | null;
  activityRecorder: ActivityRecorder;
  activityQueryService: ActivityQueryService;
  activityEventFactory: ActivityEventFactory;
  activityMaintenanceTimer: NodeJS.Timeout | null;
  terminalActivity: TerminalActivityDependencies;
  authStore: AuthStore;
  authService: AuthService;
  authCookieName: string;
  authSecureCookies: boolean;
  terminalSessionManager: TerminalSessionManager;
  terminalQuickInputStore: LowDbTerminalQuickInputStore;
  terminalQuickInputService: TerminalQuickInputService;
  terminalStateService: TerminalStateService;
  agentTeamService: AgentTeamService;
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
  appServerEventConsumer: AppServerEventConsumerHandle | null;
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

function resolveDefaultTmuxSocketPath(browserProfileDir: string): string {
  const profileId = createHash("sha256")
    .update(browserProfileDir)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `rw-tmux-${profileId}`, "tmux.sock");
}

export async function createRuntimeServices(): Promise<RuntimeServices> {
  const storagePaths = resolveStoragePaths(process.env);
  const activityPaths = resolveActivityStoragePaths(process.env);
  let activityStore: ActivityStore | null = null;
  try {
    activityStore = await ActivityStore.create({
      databasePath: activityPaths.activityDatabaseFile,
      env: process.env,
    });
  } catch (error) {
    logger.warn("activity.initialize.failed", {
      component: "activity",
      message: "Activity is unavailable; Backend will continue without it",
      error,
    });
  }
  const runtimeChannel =
    process.env.RUNWEAVE_DESKTOP_CHANNEL === "stable" ||
    process.env.RUNWEAVE_DESKTOP_CHANNEL === "beta"
      ? process.env.RUNWEAVE_DESKTOP_CHANNEL
      : "dev";
  const activityInstanceId =
    process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() ||
    `backend:${process.pid}:${crypto
      .createHash("sha256")
      .update(storagePaths.browserProfileDir)
      .digest("hex")
      .slice(0, 12)}`;
  const activityEventFactory = new ActivityEventFactory({
    producerName: "runweave-backend",
    producerVersion: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || "builtin",
    producerInstanceId: activityInstanceId,
    runtimeChannel,
    runtimeSurface: "backend",
    sourceRevision: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim(),
    backendProfileId: path.basename(storagePaths.browserProfileDir),
  });
  const activityRecorder = new ActivityRecorder(activityStore);
  const activityQueryService = new ActivityQueryService(activityStore);
  const terminalActivity = {
    recorder: activityRecorder,
    eventFactory: activityEventFactory,
  };
  if (activityStore) {
    await activityRecorder.recordBatch([
      activityEventFactory.create({
        eventName: "producer.instance.started",
        payload: {
          pid: process.pid,
          releaseId: process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim() || null,
        },
      }),
    ]);
  }
  const activityMaintenanceOwnerId = `${activityInstanceId}:${crypto.randomUUID()}`;
  let activityMaintenanceRunning = false;
  const runActivityMaintenance = (): void => {
    if (!activityStore || activityMaintenanceRunning) return;
    activityMaintenanceRunning = true;
    void (async () => {
      try {
        while (true) {
          const job = await activityStore?.runDelete(activityMaintenanceOwnerId);
          if (!job || job.status === "completed" || job.status === "blocked") break;
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 50);
            timeout.unref();
          });
        }
        await activityStore?.runRetention(activityMaintenanceOwnerId);
      } catch (error) {
        logger.warn("activity.maintenance.failed", {
          component: "activity",
          message: "Activity maintenance pass failed",
          error,
        });
      } finally {
        activityMaintenanceRunning = false;
      }
    })();
  };
  const activityMaintenanceTimer = activityStore
    ? setInterval(runActivityMaintenance, 15 * 60 * 1000)
    : null;
  activityMaintenanceTimer?.unref();
  runActivityMaintenance();
  const authConfig = loadAuthConfig();
  const authStore = new LowDbAuthStore(storagePaths.authStoreFile);
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
  await terminalQuickInputStore.initialize();
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
      resolveDefaultTmuxSocketPath(storagePaths.browserProfileDir),
    env: process.env,
  });
  const tmuxOutputWatcher = new TmuxOutputWatcher({
    outputDir: path.join(
      path.dirname(storagePaths.terminalSessionStoreFile),
      "tmux-output",
    ),
    terminalSessionManager,
    tmuxService,
    tmuxLifecycleCoordinator,
  });
  await terminalSessionManager.initialize();
  const tmuxEnvironmentFailures =
    await syncExistingTmuxSessionEnvironments(
      terminalSessionManager,
      tmuxService,
    );
  for (const failure of tmuxEnvironmentFailures) {
    logger.warn("terminal.tmux.environment-sync.startup.failed", {
      message: "Failed to refresh terminal tmux environment during startup",
      terminalSessionId: failure.terminalSessionId,
      error: failure.error,
    });
  }
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
  void tmuxOutputWatcher.watchExistingSessions().catch((error) => {
    logger.warn("terminal.tmux.output-watch.startup.failed", {
      message: "Failed to recover tmux output watchers during startup",
      error,
    });
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
  });
  agentTeamService.initialize();
  const appServerHistoryGateway = new AppServerHistoryGateway();
  const workHistoryService = new WorkHistoryService(
    terminalSessionManager,
    activityQueryService,
    appServerHistoryGateway,
    agentTeamService,
  );
  const attentionService = new AttentionService(
    terminalSessionManager,
    terminalCompletionEventService,
    agentTeamService,
  );

  return {
    activityStore,
    activityRecorder,
    activityQueryService,
    activityEventFactory,
    activityMaintenanceTimer,
    terminalActivity,
    authStore,
    authService,
    authCookieName: authConfig.refreshCookieName,
    authSecureCookies: authConfig.secureCookies,
    terminalSessionManager,
    terminalQuickInputStore,
    terminalQuickInputService,
    terminalStateService,
    agentTeamService,
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
    appServerEventConsumer: null,
  };
}
