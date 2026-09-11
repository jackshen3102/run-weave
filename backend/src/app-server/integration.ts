import path from "node:path";
import { discoverAppServer, getAppServerStatus } from "@runweave/shared/app-server/discovery";
import type { AppServerConnectionInfo } from "@runweave/shared/app-server/types";
import { logger } from "../logging/index";
import { resolveStoragePaths } from "../utils/path";
import type { RuntimeServices } from "../bootstrap/runtime-services";
import type { AppServerIntegrationStatus } from "../runtime-status/provider";
import { AppServerClient } from "./client";
import { AppServerEventConsumer } from "./event-consumer";
import { AppServerEventCursorStore } from "./event-cursor-store";
import { handleAgentCompletionEvent } from "./handlers/agent-completion";
import { handleAgentHookEvent } from "./handlers/agent-hook";
import { handleAgentLifecycleEvent } from "./handlers/agent-lifecycle";
import { isEventOwnedByThisBackend } from "./ownership";
import { startAppServerRuntimeStatusSource } from "./runtime-status-source";

const APP_SERVER_AGENT_EVENT_CONSUMER_ID = "backend:agent-events";

const DISCOVERY_INTERVAL_MS = 5_000;

export async function initializeAppServerEventIntegration(
  services: RuntimeServices,
  backendBaseUrl: string,
): Promise<void> {
  const runtime = services.runtimeStatus;
  if (runtime.appServerIntegrationHandle) return;
  if (process.env.RUNWEAVE_APP_SERVER_DISCOVERY?.trim() === "disabled") {
    runtime.appServerIntegration = {
      state: "disabled",
      summary: "App Server 集成已主动禁用",
      observedAt: Date.now(),
    };
    return;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let connection: AppServerConnectionInfo | null = null;
  const abort = new AbortController();

  const stopConsumers = async (): Promise<void> => {
    await runtime.appServerSource?.stop();
    runtime.appServerSource = null;
    await runtime.eventConsumer?.stop();
    runtime.eventConsumer = null;
    connection = null;
  };
  const unavailable = (status: AppServerIntegrationStatus): void => {
    if (runtime.appServerIntegration.summary === status.summary) return;
    runtime.appServerIntegration = status;
    logger.info("backend.app-server.unavailable", {
      component: "app-server",
      message: status.summary,
    });
  };
  const reconcile = async (): Promise<void> => {
    // A connected stream needs no discovery polling. A disconnected stream
    // retains its cursor while we look for a replacement singleton address.
    if (runtime.eventConsumer?.getStatusSnapshot().state === "connected") return;
    try {
      const next = await discoverAppServer({ env: process.env });
      if (stopped) return;
      if (!next) {
        if (!runtime.eventConsumer) {
          const status = await describeUnavailableAppServer();
          if (!stopped) unavailable(status);
        }
        return;
      }
      if (
        connection?.baseUrl === next.baseUrl &&
        connection.token === next.token
      ) return;
      await stopConsumers();
      if (stopped) return;
      await connectAppServerEventIntegration(
        services,
        backendBaseUrl,
        next,
        AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
      );
      connection = next;
    } catch (error) {
      await stopConsumers();
      if (stopped) return;
      unavailable({
        state: "unhealthy",
        summary: "App Server 事件集成初始化失败，正在自动重试；终端状态同步和完成事件补偿暂不可用",
        observedAt: Date.now(),
      });
      logger.warn("backend.app-server.integration.failed", {
        component: "app-server",
        message: "App Server integration failed; discovery will retry",
        error,
      });
    }
  };
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= reconcile().finally(() => {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(() => void run(), DISCOVERY_INTERVAL_MS);
        timer.unref();
      }
    });
    return inFlight;
  };
  // Register the owner before the first await so startup rollback also drains it.
  runtime.appServerIntegrationHandle = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort.abort();
      stopping ??= (async () => {
        await inFlight;
        await stopConsumers();
      })();
      return stopping;
    },
  };
  await run();
}

async function connectAppServerEventIntegration(
  services: RuntimeServices,
  backendBaseUrl: string,
  connection: AppServerConnectionInfo,
  signal: AbortSignal,
): Promise<void> {
  const client = new AppServerClient(connection);
  const storagePaths = resolveStoragePaths(process.env);
  const backendInstanceId = `backend:${process.pid}:${backendBaseUrl}`;
  const startedEvent = await client.postEvent({
    kind: "backend.started",
    source: {
      app: "backend",
      instanceId: backendInstanceId,
      pid: process.pid,
    },
    dedupeKey: `backend.started:${backendInstanceId}`,
    payload: {
      baseUrl: backendBaseUrl,
    },
  }, signal);
  if (!startedEvent) throw new Error("App Server rejected backend registration");

  const cursorStore = new AppServerEventCursorStore(
    path.join(
      path.dirname(storagePaths.terminalSessionStoreFile),
      "app-server-event-cursors.json",
    ),
  );
  const consumer = new AppServerEventConsumer({
    client,
    cursorStore,
    consumerId: APP_SERVER_AGENT_EVENT_CONSUMER_ID,
    kinds: ["agent.hook", "agent.completion", "agent.lifecycle.observed"],
    isRelevant: (event) =>
      isEventOwnedByThisBackend(event, services.terminalSessionManager) &&
      event.source.instanceId !== backendInstanceId,
    handler: async (event) => {
      if (event.kind === "agent.hook") {
        await handleAgentHookEvent(event, {
          terminalSessionManager: services.terminalSessionManager,
          terminalStateService: services.terminalStateService,
        });
        return;
      }
      if (event.kind === "agent.lifecycle.observed") {
        await handleAgentLifecycleEvent(event, {
          terminalSessionManager: services.terminalSessionManager,
          terminalStateService: services.terminalStateService,
          activity: services.terminalActivity,
        });
        return;
      }
      if (event.kind === "agent.completion") {
        const completion = await handleAgentCompletionEvent(event, {
          terminalSessionManager: services.terminalSessionManager,
          terminalStateService: services.terminalStateService,
        });
        if (completion) {
          const reconciled =
            await services.agentTeamService.reconcileCompletionSignal({
              ...completion,
              source: "app_server",
            });
          logger.info("backend.app-server.agent-team_completion", {
            component: "app-server",
            message: "App-server completion checked Agent Team outbox",
            terminalSessionId: completion.terminalSessionId,
            panelId: completion.panelId,
            reconciled,
          });
        }
      }
    },
  });
  services.runtimeStatus.eventConsumer = consumer;
  await consumer.start();
  services.runtimeStatus.appServerSource = startAppServerRuntimeStatusSource(
    client,
    services.runtimeStatus.registry,
  );

  logger.info("backend.app-server.connected", {
    component: "app-server",
    message: "Backend connected to Runweave app-server event center",
    consumerId: APP_SERVER_AGENT_EVENT_CONSUMER_ID,
  });
}

async function describeUnavailableAppServer(): Promise<AppServerIntegrationStatus> {
  const env = process.env;
  let configured = Boolean(
    env.RUNWEAVE_APP_SERVER_URL?.trim() || env.RUNWEAVE_APP_SERVER_TOKEN?.trim(),
  );
  if (env.RUNWEAVE_APP_SERVER_DISCOVERY?.trim() !== "explicit") {
    const status = await getAppServerStatus({ env });
    configured ||= Boolean(status.lock || status.hasToken || status.currentRuntime);
  }
  return {
    state: configured ? "unhealthy" : "unconfigured",
    summary: configured
      ? "App Server 暂时无法连接，正在自动重试；终端状态同步和完成事件补偿暂不可用"
      : "App Server 未配置",
    observedAt: Date.now(),
  };
}
