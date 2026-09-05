import * as Lark from "@larksuiteoapi/node-sdk";
import type { AuthContext } from "../client/auth-context.js";
import type { FeishuConfig } from "./config.js";

export async function runBridgeConnection(params: {
  config: FeishuConfig;
  auth: AuthContext;
  dispatcher: Lark.EventDispatcher;
  stderr: Pick<NodeJS.WriteStream, "write">;
  signal: AbortSignal;
}): Promise<void> {
  const log = (event: string) =>
    params.stderr.write(
      `${new Date().toISOString()} Feishu bridge: ${event}\n`,
    );
  const client = new Lark.WSClient({
    appId: params.config.appId,
    appSecret: params.config.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => log("websocket_ready"),
    onReconnected: () => log("websocket_reconnected"),
    onReconnecting: () => log("websocket_reconnecting"),
    onError: () => log("websocket_failed"),
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
      if (status.state === "connected") disconnectedSince = now;
      if (
        resumed ||
        status.state === "failed" ||
        now - disconnectedSince > 120_000
      ) {
        log(resumed ? "resume_reconnect" : "websocket_restart");
        client.close({ force: true });
        disconnectedSince = now;
        await client.start({ eventDispatcher: params.dispatcher });
      }
      try {
        await params.auth.requestJson("/api/auth/verify", {
          signal: AbortSignal.any([params.signal, AbortSignal.timeout(10_000)]),
        });
        if (lastBackendState !== "ready") log("backend_ready");
        lastBackendState = "ready";
      } catch {
        if (lastBackendState !== "unavailable") log("backend_unavailable");
        lastBackendState = "unavailable";
      }
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
