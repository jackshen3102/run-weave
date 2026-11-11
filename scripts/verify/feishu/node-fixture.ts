import { materializeFeishuInput } from "../../../backend/src/feishu/attachment-input";
import { Readable } from "node:stream";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  initializeConfiguration,
  emptyConfiguration,
} from "../../../packages/config-node/src/index";
import { FeishuBridgeConnector } from "../../../backend/src/feishu/bridge-connector";
import { FeishuBridgeError } from "../../../packages/shared/src/feishu/bridge";
export async function runNodeFixture() {
  const [url, backendId, token, configRoot] = process.argv.slice(3);
  if (!configRoot) throw new Error("fixture configuration root required");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const context = { kind: "stable" as const, instanceId: "stable", configRoot };
  const config = emptyConfiguration(context);
  config.services = {
    feishu: {
      role: "node",
      node: { url: "https://fixture.example", token: token! },
    },
  };
  await writeFile(
    path.join(configRoot, "settings.yaml"),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  initializeConfiguration(context).requireDomain("services.feishu");
  const { runFeishuCommand } =
    await import("../../../packages/runweave-cli/src/commands/feishu");
  const { createInternalTerminalCompletionRouter } =
    await import("../../../backend/src/routes/terminal/completion");
  const requireBackend = createRequire(
    path.resolve(__dirname, "../../../backend/package.json"),
  );
  const express = requireBackend(
    "express",
  ) as typeof import("../../../backend/node_modules/express");
  let crash = false;
  const attachmentDirectories = new Set<string>();
  const connector = new FeishuBridgeConnector({
    url: url!,
    backendId: backendId!,
    token: token!,
    report: () => {},
    getTerminal: async (id) => {
      if (id !== "same-terminal") throw new FeishuBridgeError("not_found");
      return { status: "running" };
    },
    input: async (frame) => {
      const deliveredText = await materializeFeishuInput(frame);
      if (frame.attachment) attachmentDirectories.add(path.dirname(JSON.parse(deliveredText.split("当前任务读取：")[1]!)));
      process.send?.({ type: "input", backendId, frame, deliveredText });
      if (crash) {
        setTimeout(() => process.exit(0), 10);
        await new Promise(() => {});
      }
      return { inputAccepted: true, inputEnqueued: true };
    },
  });
  const app = express();
  app.use(express.json());
  type CompletionOptions = Parameters<
    typeof createInternalTerminalCompletionRouter
  >[0];
  const sessions = {
    getSession: (id: string) => (id === "same-terminal" ? { id } : null),
    feishuNotifications: { decide: async () => ({ action: "send" }) },
  } as unknown as CompletionOptions["terminalSessionManager"];
  app.use(
    "/internal/terminal-completion",
    createInternalTerminalCompletionRouter({
      terminalSessionManager: sessions,
      completionEventService: {} as CompletionOptions["completionEventService"],
      hookToken: token,
      feishuConnector: connector,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/terminal-completion`;
  const unauthorized = await fetch(`${endpoint}/feishu/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (unauthorized.status !== 401) throw new Error("Hook auth bypass");
  process.on("message", async (msg: { type: string }) => {
    if (msg.type === "crash-on-input") {
      crash = true;
      process.send?.({ type: "armed" });
    }
    if (msg.type === "stop") {
      await connector.close();
      for (const directory of attachmentDirectories) await rm(directory, { recursive: true, force: true });
      server.close();
      process.exit(0);
    }
    if (msg.type === "notify") {
      try {
        let output = "";
        await runFeishuCommand("notify", ["--stdin", "--json"], {
          env: {
            RUNWEAVE_COMPLETION_HOOK_ENDPOINT: endpoint,
            RUNWEAVE_HOOK_TOKEN: token,
            RUNWEAVE_TERMINAL_SESSION_ID: "same-terminal",
          },
          stdin: Readable.from([
            JSON.stringify({
              terminalSessionId: "same-terminal",
              notificationText: "fixture final answer",
              feishuNotificationId: "1",
            }),
          ]) as NodeJS.ReadStream,
          stdout: {
            write: (chunk) => {
              output += chunk;
              return true;
            },
          },
          stderr: { write: () => true },
        });
        const result = JSON.parse(output);
        if (!result.sent) throw new Error("Not sent");
        process.send?.({ type: "notified", result });
      } catch (error) {
        process.send?.({
          type: "notify-failed",
          reason: error instanceof Error ? error.message : "failed",
        });
      }
    }
  });
  connector.start();
}
