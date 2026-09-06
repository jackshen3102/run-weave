import * as Lark from "@larksuiteoapi/node-sdk";
import type { AuthContext } from "../client/auth-context.js";
import type { FeishuConfig } from "./config.js";
import type { FeishuRuntimeStatusReporter } from "./runtime-status.js";

export async function runBridgeConnection(params: {
  config: FeishuConfig;
  auth: AuthContext;
  dispatcher: Lark.EventDispatcher;
  stderr: Pick<NodeJS.WriteStream, "write">;
  signal: AbortSignal;
  statusReporter: FeishuRuntimeStatusReporter;
}): Promise<void> {
  const log = (event: string) =>
    params.stderr.write(
      `${new Date().toISOString()} Feishu bridge: ${event}\n`,
    );
  const client = new Lark.WSClient({
    appId: params.config.appId,
    appSecret: params.config.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => {
      params.statusReporter.markLarkConnected();
      log("websocket_ready");
    },
    onReconnected: () => {
      params.statusReporter.markLarkConnected();
      log("websocket_reconnected");
    },
    onReconnecting: () => {
      params.statusReporter.markLarkDisconnected();
      log("websocket_reconnecting");
    },
    onError: () => {
      params.statusReporter.markLarkDisconnected();
      log("websocket_failed");
    },
  });
  let lastTick = Date.now();
  let lastBackendState = "";
  let checking = false;
  let disconnectedSince = Date.now();
  const check = async () => {
    if (checking || params.signal.aborted) return;
    checking = true;
    try {
      const now = Date.now();
      const resumed = now - lastTick > 60_000;
      lastTick = now;
      const status = client.getConnectionStatus();
      if (status.state === "connected") {
        disconnectedSince = now;
        params.statusReporter.markLarkConnected();
      } else {
        params.statusReporter.markLarkDisconnected();
      }
      if (
        resumed ||
        status.state === "failed" ||
        now - disconnectedSince > 120_000
      ) {
        log(resumed ? "resume_reconnect" : "websocket_restart");
        client.close({ force: true });
        await client.start({ eventDispatcher: params.dispatcher });
      }
      try {
        await params.auth.requestJson("/api/auth/verify", {
          signal: AbortSignal.any([params.signal, AbortSignal.timeout(10_000)]),
        });
        if (lastBackendState !== "ready") log("backend_ready");
        params.statusReporter.markBackendConnected();
        lastBackendState = "ready";
      } catch {
        if (lastBackendState !== "unavailable") log("backend_unavailable");
        params.statusReporter.markBackendDisconnected();
        lastBackendState = "unavailable";
      }
      void params.statusReporter.publish().catch(() => undefined);
    } finally {
      checking = false;
    }
  };
  const stopped = new Promise<void>((resolve) => {
    if (params.signal.aborted) resolve();
    else
      params.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const timer = setInterval(() => {
    void check().catch(() => log("health_check_failed"));
  }, 15_000);
  try {
    if (!params.signal.aborted) {
      await client.start({ eventDispatcher: params.dispatcher });
      void check().catch(() => log("health_check_failed"));
    }
    // SDK start() only schedules the connection. Hold the process lease until stop.
    await stopped;
  } finally {
    clearInterval(timer);
    client.close({ force: true });
  }
}
