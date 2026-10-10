import { runNodeFixture } from "./node-fixture";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { FeishuHubServer } from "../../../packages/runweave-cli/src/feishu/hub-server";
import { FeishuStateStore } from "../../../packages/runweave-cli/src/feishu/state-store";
import {
  FeishuBridgeMessageHandler,
  type FeishuInboundMessageEvent,
} from "../../../packages/runweave-cli/src/feishu/bridge-message-handler";
import { RemoteFeishuTerminalClient } from "../../../packages/runweave-cli/src/feishu/remote-terminal-client";
import { notifyFeishuTopic } from "../../../packages/runweave-cli/src/feishu/topic-notifier";
import { parseFeishuFrame } from "../../../packages/shared/src/feishu/bridge";
import { migrateFeishuState } from "../../feishu/migrate-state";
const backendRequire = createRequire(
  path.resolve(__dirname, "../../../backend/package.json"),
);
const { WebSocket } = backendRequire(
  "ws",
) as typeof import("../../../backend/node_modules/ws");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(25);
  }
  throw new Error(`Timeout: ${label}`);
}
if (process.argv[2] === "--node")
  void runNodeFixture().catch((error) => {
    console.error(error);
    process.exit(1);
  });
else
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rw-feishu-hub-"));
  const ids = ["a", "b", "c"].map((id) => id.repeat(64));
  const tokens = new Map(
    ids.map((id) => [id, randomBytes(32).toString("base64url")]),
  );
  const store = new FeishuStateStore({
    directory: path.join(directory, "hub"),
    hub: true,
  });
  let serial = 0;
  const roots = new Set<string>();
  const notifications: string[] = [];
  const reactions: string[] = [];
  const receipts: string[] = [];
  const fakeLark = {
    im: {
      v1: {
        message: {
          create: async () => {
            const id = `root-${++serial}`;
            roots.add(id);
            return {
              data: {
                message_id: id,
                chat_id: "chat",
                thread_id: `thread-${id}`,
              },
            };
          },
          get: async ({ path: p }: { path: { message_id: string } }) => ({
            data: {
              items: roots.has(p.message_id)
                ? [{ message_id: p.message_id }]
                : [],
            },
          }),
          reply: async ({
            path: p,
            data,
          }: {
            path: { message_id: string };
            data: { content: string };
          }) => {
            notifications.push(p.message_id);
            receipts.push(data.content);
            return {
              data: {
                message_id: `reply-${++serial}`,
                root_id: p.message_id,
                thread_id: `thread-${p.message_id}`,
              },
            };
          },
        },
        messageReaction: {
          create: async ({ path: p }: { path: { message_id: string } }) => {
            reactions.push(p.message_id);
            return {};
          },
        },
      },
    },
  } as unknown as Parameters<typeof notifyFeishuTopic>[0]["client"];
  const makeHub = (port: number) =>
    new FeishuHubServer({
      host: "127.0.0.1",
      port,
      tokens,
      notify: (backendId, payload) =>
        notifyFeishuTopic({
          client: fakeLark,
          store,
          chatId: "chat",
          backendId,
          ...payload,
        }),
    });
  let hub = makeHub(0);
  const children = new Map<string, ChildProcess>();
  const inputs: Array<{
    backendId: string;
    frame: { messageId: string; text: string };
  }> = [];
  const messages: Array<{ type: string }> = [];
  let controller = new AbortController();
  const config = {
    appId: "fixture",
    appSecret: "fixture",
    targetChatId: "chat",
    allowedOpenIds: new Set(["owner"]),
    notifyOpenIds: new Set<string>(),
  };
  const makeHandler = () =>
    new FeishuBridgeMessageHandler({
      config,
      store,
      client: fakeLark,
      stderr: { write: () => true },
      signal: controller.signal,
      clientForTopic: (topic, deadline) =>
        new RemoteFeishuTerminalClient(hub, topic.backendId!, deadline),
    });
  let handler = makeHandler();
  let port = 0;
  const startNode = (id: string) => {
    const child = fork(
      __filename,
      [
        "--node",
        `http://127.0.0.1:${port}`,
        id,
        tokens.get(id)!,
        path.join(directory, id),
      ],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    child.on(
      "message",
      (msg: {
        type: string;
        backendId: string;
        frame: { messageId: string; text: string };
      }) => {
        messages.push(msg);
        if (msg.type === "input") inputs.push(msg);
      },
    );
    children.set(id, child);
    return child;
  };
  const stopNode = async (id: string) => {
    const child = children.get(id)!;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  const ready = async (id: string) =>
    until(async () => {
      try {
        await hub.request(
          id,
          { type: "terminal.get", terminalSessionId: "same-terminal" },
          AbortSignal.timeout(500),
        );
        return true;
      } catch {
        return false;
      }
    }, "node ready");
  const topicRoots: string[] = [];
  const event = (
    i: number,
    messageId: string,
    patch: Record<string, unknown> = {},
  ): FeishuInboundMessageEvent => ({
    sender: { sender_type: "user", sender_id: { open_id: "owner" } },
    message: {
      message_id: messageId,
      create_time: String(Date.now()),
      chat_id: "chat",
      chat_type: "group",
      message_type: "text",
      root_id: topicRoots[i],
      thread_id: `thread-${topicRoots[i]}`,
      content: JSON.stringify({ text: `input-${messageId}` }),
      ...patch,
    },
  });
  try {
    port = await hub.start();
    for (const id of ids) {
      startNode(id);
      await ready(id);
    }
    for (const id of ids) {
      children.get(id)!.send({ type: "notify" });
      await until(
        async () => !!(await store.getActiveTopic("chat", "same-terminal", id)),
        "topic persisted",
      );
      topicRoots.push(
        (await store.getActiveTopic("chat", "same-terminal", id))!
          .rootMessageId,
      );
    }
    for (let i = 0; i < 3; i++) await handler.accept(event(i, `first-${i}`));
    await handler.drain();
    assert.equal(inputs.length, 3);
    for (let i = 0; i < 3; i++)
      assert.equal(
        inputs.find((input) => input.frame.messageId === `first-${i}`)
          ?.backendId,
        ids[i],
      );
    assert.equal(reactions.length, 3);
    for (const id of ids) children.get(id)!.send({ type: "notify" });
    await until(
      () => notifications.length === 3,
      "answers return to original topics",
    );
    assert.deepEqual([...notifications].sort(), [...topicRoots].sort());
    console.log(
      "PASS three node processes, identical terminal IDs, correct topic routing and notification reuse",
    );

    for (const patch of [
      { root_id: undefined },
      { thread_id: undefined },
      { root_id: "unknown" },
      { thread_id: "wrong" },
      { chat_id: "other" },
      { message_type: "image" },
    ])
      await handler.accept(event(0, `ignore-${serial++}`, patch));
    await handler.accept({
      ...event(0, "stranger"),
      sender: { sender_type: "user", sender_id: { open_id: "stranger" } },
    });
    await handler.accept(event(0, "first-0"));
    await handler.drain();
    assert.equal(inputs.length, 3);
    console.log("PASS existing-topic filter and durable message dedupe");

    const rejected = (id: string, token: string, expected: number) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/feishu/backends/${id}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        socket.on("unexpected-response", (_req, res) => {
          try {
            assert.equal(res.statusCode, expected);
            res.resume();
            socket.terminate();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        socket.on("error", () => {});
        socket.on("open", () => {
          socket.terminate();
          reject(new Error("Unauthorized connection accepted"));
        });
      });
    await rejected(ids[0]!, "wrong", 401);
    await rejected(ids[1]!, tokens.get(ids[0]!)!, 401);
    await rejected(ids[0]!, tokens.get(ids[0]!)!, 409);
    assert.throws(() =>
      parseFeishuFrame(
        JSON.stringify({
          type: "notify",
          requestId: "x",
          terminalSessionId: "same-terminal",
          notificationText: "text",
          backendId: ids[1],
        }),
      ),
    );
    console.log(
      "PASS invalid credentials, identity spoofing, duplicate connection and strict wire validation",
    );

    await stopNode(ids[1]!);
    await handler.accept(event(1, "offline-recover"));
    await pause(100);
    assert.equal(inputs.length, 3);
    startNode(ids[1]!);
    await ready(ids[1]!);
    await handler.drain();
    assert.equal(
      inputs.filter((i) => i.frame.messageId === "offline-recover").length,
      1,
    );
    await stopNode(ids[1]!);
    await handler.accept(
      event(1, "expired", { create_time: String(Date.now() - 121_000) }),
    );
    await handler.drain();
    assert.equal((await store.delivery("expired"))?.status, "failed");
    startNode(ids[1]!);
    await ready(ids[1]!);
    assert.equal(
      inputs.filter((i) => i.frame.messageId === "expired").length,
      0,
    );
    console.log(
      "PASS pre-send reconnect and expired input rejection without cross-node fallback",
    );

    children.get(ids[2]!)!.send({ type: "crash-on-input" });
    await until(() => messages.some((m) => m.type === "armed"), "crash armed");
    await handler.accept(event(2, "unknown"));
    await handler.drain();
    assert.equal((await store.delivery("unknown"))?.status, "unknown");
    startNode(ids[2]!);
    await ready(ids[2]!);
    await handler.accept(event(2, "unknown"));
    await handler.drain();
    assert.equal(
      inputs.filter((i) => i.frame.messageId === "unknown").length,
      1,
    );
    console.log(
      "PASS executed input with lost result becomes unknown and is never automatically replayed",
    );

    await store.queueEvent(event(0, "restart-wait"), "same-terminal", ids[0]);
    await store.queueEvent(
      event(0, "restart-attempt"),
      "same-terminal",
      ids[0],
    );
    await store.beginDelivery("restart-attempt", "same-terminal", ids[0]);
    await store.markInputAttempt("restart-attempt", true);
    controller.abort();
    await handler.drain();
    await hub.close();
    hub = makeHub(port);
    await hub.start();
    controller = new AbortController();
    handler = makeHandler();
    await store.recoverInterruptedDeliveries();
    await handler.recover();
    for (const id of ids) await ready(id);
    await handler.drain();
    assert.equal((await store.delivery("restart-attempt"))?.status, "unknown");
    assert.equal(
      inputs.filter((i) => i.frame.messageId === "restart-wait").length,
      1,
    );
    assert.equal(
      inputs.filter((i) => i.frame.messageId === "restart-attempt").length,
      0,
    );
    assert.equal(
      (await store.getActiveTopic("chat", "same-terminal", ids[0]))
        ?.rootMessageId,
      topicRoots[0],
    );
    console.log(
      "PASS hub restart retains bindings and only recovers unattempted input",
    );

    const legacyDir = path.join(directory, "legacy");
    const legacy = new FeishuStateStore({ directory: legacyDir });
    await notifyFeishuTopic({
      client: fakeLark,
      store: legacy,
      chatId: "chat",
      terminalSessionId: "same-terminal",
      notificationText: "legacy",
    });
    const legacyFile = path.join(legacyDir, "bridge-state.json");
    const original = await readFile(legacyFile, "utf8");
    const migrated = path.join(directory, "migrated.json");
    const sources = [{ appId: "app", backendId: ids[0]!, file: legacyFile }];
    await migrateFeishuState({
      mode: "import",
      appId: "app",
      chatId: "chat",
      sources,
      output: migrated,
    });
    assert.equal(await readFile(legacyFile, "utf8"), original);
    const migratedState = JSON.parse(await readFile(migrated, "utf8"));
    migratedState.processed["pending"] = {
      messageId: "pending",
      backendId: ids[0],
      terminalSessionId: "same-terminal",
      status: "processing",
      inputAttempted: true,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(migrated, JSON.stringify(migratedState));
    const rollback = await migrateFeishuState({
      mode: "rollback",
      appId: "app",
      chatId: "chat",
      sources,
      hubFile: migrated,
      output: path.join(directory, "rollback"),
    });
    assert.equal(
      JSON.parse(await readFile(rollback[0]!, "utf8")).processed.pending.status,
      "unknown",
    );
    await assert.rejects(() =>
      migrateFeishuState({
        mode: "import",
        appId: "app",
        chatId: "chat",
        sources: [...sources, { ...sources[0]!, backendId: ids[1]! }],
        output: path.join(directory, "conflict.json"),
      }),
    );
    console.log(
      "PASS standalone topic creation, copy-only import, conflict rejection and conservative rollback",
    );
    await hub.close();
    await pause(100);
    const failures = messages.filter(
      (message) => message.type === "notify-failed",
    ).length;
    children.get(ids[0]!)!.send({ type: "notify" });
    await until(
      () =>
        messages.filter((message) => message.type === "notify-failed").length >
        failures,
      "offline notification fails",
    );
    for (const child of children.values()) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Connector did not shut down")),
          5000,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error("Node exit failed"));
        });
      });
      child.send({ type: "stop" });
      await exited;
    }
    console.log(
      "PASS offline notification reports failure and all three connectors shut down cleanly",
    );
    console.log(
      "LIMIT controlled Feishu API and terminal adapters; real Feishu, TLS and actual three-machine execution not exercised",
    );
  } finally {
    controller.abort();
    await handler.drain();
    for (const id of children.keys()) await stopNode(id);
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  }
}
