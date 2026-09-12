// Installed as ~/.pi/agent/extensions/runweave/index.ts. Only Node built-ins at runtime.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { createBridgeTransport } from "../../../packages/agent-bridge/src/transport";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  PiAgentContext,
  PiEditorRequest,
} from "../../../packages/shared/src/terminal/pi-agent";

export default function runweave(pi: ExtensionAPI) {
  const terminalSessionId = process.env.RUNWEAVE_TERMINAL_SESSION_ID;
  const tmuxSocket = process.env.TMUX?.split(",")[0];
  const pane = process.env.TMUX_PANE;
  if (!terminalSessionId || !tmuxSocket || !pane) return;

  let context: ExtensionContext | undefined;
  let closed = false;
  let waitingForUI = false;
  let sequence = 0;
  let runId: string | null = null;
  let outcome: PiAgentContext["outcome"] = null;
  let reply = "";
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const transport = createBridgeTransport(
    "pi",
    fileURLToPath(
      new URL("./bridge/runweave-hook-bridge.cjs", import.meta.url),
    ),
  );
  let server: ReturnType<typeof createServer> | undefined;
  let socketPath: string | undefined;
  let ownsSocket = false;
  const applied = new Map<string, string>();

  function publish(
    ctx: ExtensionContext,
    event: string,
    hook: string,
    extra: Record<string, unknown> = {},
  ) {
    if (closed) return;
    const fact: PiAgentContext = {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: canonicalSessionFile(ctx.sessionManager.getSessionFile()),
      instanceId,
      startedAt,
      sequence: ++sequence,
      runId,
      leafId: ctx.sessionManager.getLeafId(),
      event,
      outcome,
    };
    // Custom entries never enter LLM context. Persist before attempting delivery.
    pi.appendEntry("runweave.lifecycle", {
      ...fact,
      terminalSessionId,
      tmuxPaneId: pane,
      operationId: process.env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID ?? null,
      hook,
      timestamp: new Date().toISOString(),
    });
    transport.publish({
      hook_event_name: hook,
      session_id: fact.sessionId,
      cwd: ctx.cwd,
      pi: fact,
      ...extra,
    });
  }

  async function openEditor(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const directory = path.join(
      "/tmp",
      `rw-pi-${process.getuid?.() ?? "user"}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const key = createHash("sha256")
      .update(`${tmuxSocket}\0${pane}`)
      .digest("hex")
      .slice(0, 24);
    socketPath = path.join(directory, `${key}.sock`);
    // Never unlink another live Pi's control socket (nested agents inherit TMUX).
    const alive = await new Promise<boolean>((resolve) => {
      const probe = request({ socketPath, path: "/", timeout: 300 }, (res) => {
        res.resume();
        resolve(true);
      });
      probe.on("timeout", () => {
        probe.destroy();
        resolve(true);
      });
      probe.on("error", (error: NodeJS.ErrnoException) =>
        resolve(!["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")),
      );
      probe.end();
    });
    if (alive) {
      closed = true;
      socketPath = undefined;
      return;
    }
    await unlink(socketPath).catch(() => {});
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => {
        body += part;
        if (Buffer.byteLength(body) > 1024 * 1024) req.destroy();
      });
      req.on("end", () => {
        try {
          const input = JSON.parse(body) as PiEditorRequest;
          if (
            req.method !== "POST" ||
            req.url !== "/editor" ||
            closed ||
            waitingForUI ||
            !context ||
            input.version !== 1 ||
            input.terminalSessionId !== terminalSessionId ||
            input.threadId !== context.sessionManager.getSessionId() ||
            input.instanceId !== instanceId ||
            typeof input.requestId !== "string" ||
            !input.requestId ||
            typeof input.text !== "string"
          )
            throw new Error("Pi editor identity mismatch");
          if (applied.has(input.requestId))
            throw new Error(
              "Pi editor request was already applied; inspect the terminal before retrying",
            );
          if (!applied.has(input.requestId)) {
            context.ui.setEditorText(input.text);
            applied.set(input.requestId, input.text);
            if (applied.size > 64) applied.delete(applied.keys().next().value!);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ applied: true }));
        } catch {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              applied: false,
              error: "Pi editor unavailable or identity changed",
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, resolve);
    });
    ownsSocket = true;
    await chmod(socketPath, 0o600);
  }

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) {
      closed = true;
      return;
    }
    // Older Pi versions do not provide the settled lifecycle contract.
    try {
      let directory = path.dirname(realpathSync(process.argv[1]!));
      let version = "";
      for (
        let depth = 0;
        depth < 5;
        depth++, directory = path.dirname(directory)
      ) {
        try {
          const pkg = JSON.parse(
            readFileSync(path.join(directory, "package.json"), "utf8"),
          );
          if (pkg.name === "@earendil-works/pi-coding-agent") {
            version = pkg.version;
            break;
          }
        } catch {
          /* Bundled CLI may be nested under dist/bundle. */
        }
      }
      const [major, minor, patch] = version.split(".").map(Number);
      if (major !== 0 || minor! < 85 || (minor === 85 && patch! < 1))
        throw new Error("unsupported");
    } catch {
      closed = true;
      if (ctx.hasUI)
        ctx.ui.notify(
          "Runweave requires Pi 0.85.1 or a compatible 0.x release",
          "warning",
        );
      return;
    }
    context = ctx;
    // Resolve the actual pane rather than trusting an inherited parent panel ID.
    const result = spawnSync(
      process.env.TMUX_BINARY || "tmux",
      [
        "-S",
        tmuxSocket,
        "display-message",
        "-p",
        "-t",
        pane,
        "#{@runweave_panel_id}",
      ],
      { encoding: "utf8", timeout: 1000 },
    );
    const panelId = result.status === 0 ? result.stdout.trim() : "";
    if (!panelId) {
      closed = true;
      return;
    }
    process.env.RUNWEAVE_TERMINAL_PANEL_ID = panelId;
    await openEditor(ctx).catch(() =>
      ctx.ui.notify("Runweave Pi editor unavailable", "warning"),
    );
    publish(ctx, `session_start:${event.reason}`, "SessionStart", {
      source: event.reason === "resume" ? "resume" : "startup",
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    runId ??= randomUUID();
    outcome = null;
    reply = "";
    publish(ctx, "agent_start", "UserPromptSubmit");
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      const content = event.message.content;
      const prompt =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      publish(ctx, "user_message", "UserPromptSubmit", {
        prompt: prompt.slice(0, 8000),
      });
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    outcome =
      event.message.stopReason === "error"
        ? "failed"
        : event.message.stopReason === "aborted"
          ? "interrupted"
          : event.message.stopReason === "stop"
            ? "completed"
            : null;
    reply = event.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 8000);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle() || !runId) return;
    publish(ctx, "agent_settled", "Stop", { last_assistant_message: reply });
    runId = null;
  });
  pi.on("tool_execution_start", (event, ctx) =>
    publish(ctx, "tool_execution_start", "PreToolUse", {
      tool_use_id: event.toolCallId,
      tool_name: event.toolName,
    }),
  );
  pi.on("tool_execution_end", (event, ctx) =>
    publish(ctx, "tool_execution_end", "PostToolUse", {
      tool_use_id: event.toolCallId,
      tool_name: event.toolName,
    }),
  );
  pi.on("ui_prompt_start", (_event, ctx) => {
    waitingForUI = true;
    publish(ctx, "ui_prompt_start", "AgentMetadata");
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    waitingForUI = false;
    publish(ctx, "ui_prompt_end", "AgentMetadata");
  });
  pi.on("session_tree", (_event, ctx) =>
    publish(ctx, "session_tree", "AgentMetadata"),
  );
  pi.on("model_select", (_event, ctx) =>
    publish(ctx, "model_select", "AgentMetadata"),
  );
  pi.on("session_shutdown", async () => {
    closed = true;
    context = undefined;
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (ownsSocket && socketPath) await unlink(socketPath).catch(() => {});
    await transport.drain();
  });
}

function canonicalSessionFile(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return realpathSync(file);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return file;
    }
  }
}
