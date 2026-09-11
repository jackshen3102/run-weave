import path from "node:path";
import { discoverAppServer, getAppServerStatus } from "@runweave/shared/app-server/discovery";
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

export async function initializeAppServerEventIntegration(
  services: RuntimeServices,
  backendBaseUrl: string,
): Promise<void> {
  try {
    if (process.env.RUNWEAVE_APP_SERVER_DISCOVERY?.trim() === "disabled") {
      services.runtimeStatus.appServerIntegration = {
        state: "disabled",
        summary: "App Server 集成已主动禁用",
        observedAt: Date.now(),
      };
      return;
    }
    const connection = await discoverAppServer({ env: process.env });
    if (!connection) {
      services.runtimeStatus.appServerIntegration = await describeUnavailableAppServer();
      logger.info("backend.app-server.unavailable", {
        component: "app-server",
        message:
          "Runweave app-server unavailable; backend will continue without global event center",
      });
      return;
    }

    const client = new AppServerClient(connection);
    const storagePaths = resolveStoragePaths(process.env);
    const backendInstanceId = `backend:${process.pid}:${backendBaseUrl}`;
    await client.postEvent({
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
    });

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
  } catch (error) {
    services.runtimeStatus.appServerIntegration = {
      state: "unhealthy",
      summary: "App Server 事件集成初始化失败，终端状态同步和完成事件补偿不可用",
      observedAt: Date.now(),
    };
    logger.warn("backend.app-server.integration.failed", {
      component: "app-server",
      message:
        "Runweave app-server integration failed; backend will continue without global event center",
      error,
    });
  }
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
      ? "App Server 已配置但无法连接，终端状态同步和完成事件补偿不可用；请检查 App Server 服务"
      : "App Server 未配置",
    observedAt: Date.now(),
  };
}
