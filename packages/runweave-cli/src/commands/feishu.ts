import * as Lark from "@larksuiteoapi/node-sdk";
import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import { resolveFeishuConfig } from "../feishu/config.js";
import { FeishuStateStore } from "../feishu/state-store.js";
import { writeOutput } from "../output/format.js";
import {
  DEFAULT_AGENT_START_TIMEOUT_MS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  sendWithConfirmation,
} from "./terminal-agent.js";

const MAX_INPUT_BYTES = 256 * 1024;

interface NotifyPayload {
  terminalSessionId?: unknown;
  panelId?: unknown;
  terminalPanelId?: unknown;
  notificationText?: unknown;
}

export async function runFeishuCommand(
  subcommand: string | undefined,
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    stdin: NodeJS.ReadStream;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain", "stdin"]));
  const mode = resolveOutputMode(parsed.options);
  const config = resolveFeishuConfig(io.env, {
    requireTargetChatId: subcommand === "notify",
  });
  const store = new FeishuStateStore(io.env);
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  if (subcommand === "notify") {
    if (parsed.options.stdin !== true) {
      throw new CliError("rw feishu notify requires --stdin", 2);
    }
    const payload = JSON.parse(await readStdin(io.stdin)) as NotifyPayload;
    const terminalSessionId = readRequiredString(
      payload.terminalSessionId,
      "terminalSessionId",
    );
    const notificationText = readRequiredString(
      payload.notificationText,
      "notificationText",
    );
    if (!config.targetChatId) {
      throw new CliError("FEISHU_TARGET_CHAT_ID is required", 2);
    }
    const response = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: config.targetChatId,
        msg_type: "text",
        content: JSON.stringify({ text: notificationText }),
      },
    });
    const messageId = response.data?.message_id;
    const chatId = response.data?.chat_id ?? config.targetChatId;
    if (response.code || !messageId) {
      throw new Error(
        `Feishu notification failed: ${response.code ?? "missing_message_id"}`,
      );
    }
    const now = new Date();
    await store.saveBinding({
      messageId,
      chatId,
      terminalSessionId,
      panelId:
        readOptionalString(payload.panelId) ??
        readOptionalString(payload.terminalPanelId),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.bindingTtlMs).toISOString(),
    });
    writeOutput(io.stdout, mode, { sent: true, messageId, terminalSessionId });
    return;
  }

  if (subcommand === "discover") {
    const bridgeLease = await store.acquireBridgeLease();
    const wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        const openId = event.sender.sender_id?.open_id;
        if (event.sender.sender_type !== "user" || !openId) return;
        writeOutput(io.stdout, mode, {
          discovered: true,
          openId,
          chatId: event.message.chat_id,
        });
        wsClient.close();
      },
    });
    io.stderr.write("Waiting for one Feishu user message...\n");
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } finally {
      await bridgeLease.release();
    }
    return;
  }

  if (subcommand === "bridge") {
    if (config.allowedOpenIds.size === 0) {
      throw new CliError(
        "FEISHU_ALLOWED_OPEN_IDS must contain at least one open_id",
        2,
      );
    }
    const auth = await resolveAuthContext({
      profileName: getStringOption(parsed.options, "profile"),
      backendPort: getStringOption(parsed.options, "backend-port"),
      env: io.env,
    });
    const terminalClient = new TerminalHttpClient(auth);
    const bridgeLease = await store.acquireBridgeLease();
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        void handleMessage({
          event,
          config,
          store,
          client,
          terminalClient,
          stderr: io.stderr,
        }).catch((error) => {
          io.stderr.write(
            `Feishu bridge message handling failed: ${classifyDeliveryError(error)}\n`,
          );
        });
      },
    });
    const wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    const stop = (): void => {
      wsClient.close();
      void bridgeLease.release();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    writeOutput(io.stdout, mode, {
      started: true,
      transport: "feishu_websocket",
    });
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await bridgeLease.release();
    }
    return;
  }

  throw new CliError("Usage: rw feishu <notify|discover|bridge> [options]", 2);
}

async function handleMessage(params: {
  event: {
    sender: { sender_id?: { open_id?: string }; sender_type: string };
    message: {
      message_id: string;
      parent_id?: string;
      root_id?: string;
      chat_id: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string }>;
    };
  };
  config: ReturnType<typeof resolveFeishuConfig>;
  store: FeishuStateStore;
  client: Lark.Client;
  terminalClient: TerminalHttpClient;
  stderr: Pick<NodeJS.WriteStream, "write">;
}): Promise<void> {
  const { event } = params;
  const senderOpenId = event.sender.sender_id?.open_id;
  if (
    event.sender.sender_type !== "user" ||
    !senderOpenId ||
    !params.config.allowedOpenIds.has(senderOpenId) ||
    event.message.message_type !== "text"
  ) {
    return;
  }
  const parentId = event.message.parent_id ?? event.message.root_id;
  if (!parentId) {
    return;
  }
  const binding = await params.store.getBinding(parentId);
  if (!binding || binding.chatId !== event.message.chat_id) {
    return;
  }
  const deliveryState = await params.store.beginDelivery(
    event.message.message_id,
    binding.terminalSessionId,
  );
  if (deliveryState !== "started") {
    return;
  }
  let text = "";
  try {
    const parsed = JSON.parse(event.message.content) as { text?: unknown };
    text =
      typeof parsed.text === "string"
        ? stripFeishuMentions(parsed.text, event.message.mentions)
        : "";
  } catch {
    text = "";
  }
  if (!text || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    await params.store.finishDelivery(event.message.message_id, "failed");
    await safeReply(
      params.client,
      event.message.message_id,
      "投递失败：回复内容为空或过长",
    );
    return;
  }
  try {
    const result = await sendWithConfirmation({
      client: params.terminalClient,
      terminalSessionId: binding.terminalSessionId,
      text,
      enter: false,
      inputMode: "line",
      inputModeProvided: true,
      panel: binding.panelId ?? undefined,
      role: undefined,
      confirmMode: "short",
      confirmTimeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      agent: undefined,
      agentOverwrite: false,
      agentStartCommand: undefined,
      agentClearCommand: "/clear",
      agentExitCommand: undefined,
      agentStartTimeoutMs: DEFAULT_AGENT_START_TIMEOUT_MS,
    });
    if (result.inputAccepted !== true || result.inputEnqueued !== true) {
      throw new Error("Runweave did not accept terminal input");
    }
    await params.store.finishDelivery(event.message.message_id, "succeeded");
    await safeReaction(params.client, event.message.message_id);
  } catch (error) {
    await params.store.finishDelivery(event.message.message_id, "failed");
    params.stderr.write(
      `Feishu reply delivery failed: ${classifyDeliveryError(error)}\n`,
    );
    await safeReply(
      params.client,
      event.message.message_id,
      `投递失败：${classifyDeliveryError(error)}`,
    );
  }
}

export function stripFeishuMentions(
  text: string,
  mentions: Array<{ key: string }> | undefined,
): string {
  let normalized = text;
  for (const mention of mentions ?? []) {
    if (mention.key) normalized = normalized.replaceAll(mention.key, "");
  }
  return normalized.trim();
}

async function safeReply(
  client: Lark.Client,
  messageId: string,
  text: string,
): Promise<void> {
  try {
    await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
  } catch {
    // A failed Feishu receipt must never retry an already accepted terminal input.
  }
}

async function safeReaction(
  client: Lark.Client,
  messageId: string,
): Promise<void> {
  try {
    await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "DONE" } },
    });
  } catch {
    // A failed Feishu reaction must never retry an already accepted terminal input.
  }
}

function classifyDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("401") || message.includes("token"))
    return "Runweave 认证失败";
  if (message.includes("not found") || message.includes("404"))
    return "Terminal 不存在";
  if (message.includes("not running") || message.includes("exited"))
    return "Terminal 不可运行";
  if (message.includes("fetch") || message.includes("connect"))
    return "Runweave 后端不可达";
  return "Runweave 未接受输入";
}

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of stdin) value += chunk;
  return value;
}

function readRequiredString(value: unknown, name: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) throw new CliError(`Missing ${name}`, 2);
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
