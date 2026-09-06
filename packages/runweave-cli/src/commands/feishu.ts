import { runBridgeConnection } from "../feishu/bridge-runtime.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { TerminalHttpClient } from "../client/terminal-http-client.js";
import { CliError } from "../errors.js";
import {
  FeishuBridgeMessageHandler,
  type FeishuInboundMessageEvent,
} from "../feishu/bridge-message-handler.js";
import { resolveFeishuConfig } from "../feishu/config.js";
import { FeishuStateStore } from "../feishu/state-store.js";
import { notifyFeishuTopic } from "../feishu/topic-notifier.js";
import { FeishuRuntimeStatusReporter } from "../feishu/runtime-status.js";
import { writeOutput } from "../output/format.js";

const FEISHU_REQUEST_TIMEOUT_MS = 10_000;

interface NotifyPayload {
  terminalSessionId?: unknown;
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
    requireTargetChatId: subcommand === "notify" || subcommand === "bridge",
  });
  const store = new FeishuStateStore(io.env);
  const client = createFeishuClient(config.appId, config.appSecret);

  if (subcommand === "notify") {
    if (parsed.options.stdin !== true) {
      throw new CliError("rw feishu notify requires --stdin", 2);
    }
    if (!config.targetChatId) {
      throw new CliError("FEISHU_TARGET_CHAT_ID is required", 2);
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
    const result = await notifyFeishuTopic({
      client,
      store,
      chatId: config.targetChatId,
      terminalSessionId,
      notificationText,
    });
    const output = {
      sent: true,
      terminalSessionId,
      ...result,
    };
    writeOutput(
      io.stdout,
      mode,
      mode === "json"
        ? output
        : [
            `sent=${output.sent}`,
            `terminalSessionId=${output.terminalSessionId}`,
            `rootMessageId=${output.rootMessageId}`,
            `messageId=${output.messageId}`,
            `createdTopic=${output.createdTopic}`,
          ].join("\n"),
    );
    return;
  }

  if (subcommand === "discover") {
    const bridgeLease = await store.acquireBridgeLease();
    const wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = (): void => finish();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (event) => {
        const openId = event.sender.sender_id?.open_id;
        if (event.sender.sender_type !== "user" || !openId) return;
        writeOutput(io.stdout, mode, {
          discovered: true,
          openId,
          chatId: event.message.chat_id,
        });
        finish();
      },
    });
    io.stderr.write("Waiting for one Feishu user message...\n");
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
      await finished;
    } finally {
      wsClient.close({ force: true });
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await bridgeLease.release();
    }
    return;
  }

  if (subcommand === "bridge") {
    if (!config.targetChatId) {
      throw new CliError("FEISHU_TARGET_CHAT_ID is required", 2);
    }
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
      deferRefresh: true,
    });
    const terminalClient = new TerminalHttpClient(auth);
    const bridgeLease = await store.acquireBridgeLease();
    const statusReporter = new FeishuRuntimeStatusReporter(auth);
    statusReporter.start();
    const controller = new AbortController();
    try {
      await store.recoverInterruptedDeliveries();
      const handler = new FeishuBridgeMessageHandler({
        config,
        store,
        client,
        terminalClient,
        stderr: io.stderr,
        signal: controller.signal,
      });
      await handler.recover();
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (event) => {
          // Acknowledge only after durable enqueue, not after terminal execution.
          await handler.accept(event as FeishuInboundMessageEvent);
        },
      });
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      writeOutput(io.stdout, mode, {
        started: true,
        transport: "feishu_websocket",
      });
      try {
        await runBridgeConnection({
          config,
          auth,
          dispatcher,
          stderr: io.stderr,
          signal: controller.signal,
          statusReporter,
        });
      } finally {
        controller.abort();
        await handler.drain();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    } finally {
      await statusReporter.stop();
      await bridgeLease.release();
    }
    return;
  }

  throw new CliError("Usage: rw feishu <notify|discover|bridge> [options]", 2);
}

function createFeishuClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    httpInstance: new TimeoutHttpInstance(
      Lark.defaultHttpInstance,
      FEISHU_REQUEST_TIMEOUT_MS,
    ),
  });
}

class TimeoutHttpInstance implements Lark.HttpInstance {
  constructor(
    private readonly delegate: Lark.HttpInstance,
    private readonly timeoutMs: number,
  ) {}

  request<T = unknown, R = T, D = unknown>(
    options: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.request<T, R, D>({
      ...options,
      timeout: this.timeoutMs,
    });
  }

  get<T = unknown, R = T, D = unknown>(
    url: string,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.get<T, R, D>(url, this.withTimeout(options));
  }

  delete<T = unknown, R = T, D = unknown>(
    url: string,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.delete<T, R, D>(url, this.withTimeout(options));
  }

  head<T = unknown, R = T, D = unknown>(
    url: string,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.head<T, R, D>(url, this.withTimeout(options));
  }

  options<T = unknown, R = T, D = unknown>(
    url: string,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.options<T, R, D>(url, this.withTimeout(options));
  }

  post<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.post<T, R, D>(url, data, this.withTimeout(options));
  }

  put<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.put<T, R, D>(url, data, this.withTimeout(options));
  }

  patch<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: Lark.HttpRequestOptions<D>,
  ): Promise<R> {
    return this.delegate.patch<T, R, D>(url, data, this.withTimeout(options));
  }

  private withTimeout<D>(
    options?: Lark.HttpRequestOptions<D>,
  ): Lark.HttpRequestOptions<D> {
    return { ...options, timeout: this.timeoutMs };
  }
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
