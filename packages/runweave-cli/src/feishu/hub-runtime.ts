import * as Lark from "@larksuiteoapi/node-sdk";
import { configuration, settingText } from "@runweave/config-node";
import { FeishuHubServer } from "./hub-server.js";
import { RemoteFeishuTerminalClient } from "./remote-terminal-client.js";
import {
  FeishuBridgeMessageHandler,
  type FeishuInboundMessageEvent,
} from "./bridge-message-handler.js";
import { notifyFeishuTopic } from "./topic-notifier.js";
import { FeishuRuntimeStatusReporter } from "./runtime-status.js";
import { runBridgeConnection } from "./bridge-runtime.js";
import type { FeishuConfig } from "./config.js";
import type { FeishuStateStore } from "./state-store.js";
export async function runFeishuHub(
  config: FeishuConfig,
  store: FeishuStateStore,
  client: Lark.Client,
  stderr: Pick<NodeJS.WriteStream, "write">,
  started: (port: number) => void,
): Promise<void> {
  if (!config.targetChatId || !config.allowedOpenIds.size)
    throw new Error("Hub requires target chat and allowed users");
  const backends = configuration().get(
    "services.feishu.hub.backends",
  ) as Record<string, { token: string }>;
  const tokens = new Map(
    Object.entries(backends).map(([id, entry]) => [id, entry.token]),
  );
  const hub = new FeishuHubServer({
    host: settingText("services.feishu.hub.host") ?? "127.0.0.1",
    port: configuration().get<number>("services.feishu.hub.port")!,
    tokens,
    notify: async (backendId, payload) => {
      const mentions = [...config.notifyOpenIds]
        .map((id) => `<at user_id="${id}"></at>`)
        .join(" ");
      return notifyFeishuTopic({
        client,
        store,
        chatId: config.targetChatId!,
        backendId,
        ...payload,
        notificationText: `${mentions ? `${mentions}\n` : ""}机器: ${backendId.slice(0, 12)}\n${payload.notificationText}`,
      });
    },
  });
  const lease = await store.acquireBridgeLease();
  const reporter = new FeishuRuntimeStatusReporter(async (report) => {
    hub.publish(report);
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  const handler = new FeishuBridgeMessageHandler({
    config,
    store,
    client,
    stderr,
    signal: controller.signal,
    clientForTopic: (topic, deadline) =>
      new RemoteFeishuTerminalClient(hub, topic.backendId!, deadline),
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const port = await hub.start();
    await store.recoverInterruptedDeliveries();
    await handler.recover();
    reporter.start();
    started(port);
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) =>
        handler.accept(event as FeishuInboundMessageEvent),
    });
    await runBridgeConnection({
      config,
      dispatcher,
      stderr,
      signal: controller.signal,
      statusReporter: reporter,
    });
  } finally {
    controller.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await handler.drain();
      await reporter.stop();
    } finally {
      try {
        await hub.close();
      } finally {
        await lease.release();
      }
    }
  }
}
