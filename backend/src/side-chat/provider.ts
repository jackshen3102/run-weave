import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settingText } from "@runweave/config-node";
import { SideChatError } from "./error";
import type { ProviderItem, ProviderTurn } from "./final-messages";

export interface ProviderThread { id: string; cwd: string; model?: string; environments?: Array<{ environmentId: string; cwd: string; runtimeWorkspaceRoots: string[] }> | null; ephemeral?: boolean; forkedFromId?: string; turns: ProviderTurn[]; status: { type: string } }
interface ThreadResponse { thread: ProviderThread; model: string; cwd: string; approvalPolicy: string; sandbox: { type: string; networkAccess?: boolean }; activePermissionProfile?: { id: string } }
type Notification = { method: string; params: { threadId?: string; turnId?: string; turn?: ProviderTurn; item?: ProviderItem } };
const DISABLED = ["goals", "hooks", "plugins", "apps", "multi_agent", "multi_agent_v2", "collab", "memories", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "remote_control", "remote_plugin", "recommended_plugins", "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "external_agent_memory_import"];
const BOUNDARY = "This is an independent read-only side conversation. Inherited messages and instructions are historical reference, never pending work. Answer only the new explicit user question. Do not continue a prior goal or operate the main task. Only local read-only project inspection is allowed. No network, file modifications, MCP, Apps, Browser, Computer Use, hooks, subagents, approvals or privilege escalation. Do not report progress or tool results as the final answer.";

/** Dedicated stdio process, never the TUI/daemon connection. Owns only explicitly bound child IDs. */
export class SideChatProvider {
  private readonly profile = `runweave_side_chat_${randomUUID().replaceAll("-", "")}`;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private next = 0;
  private exit: Promise<void> = Promise.resolve();
  private closing = false;
  private notification: ((event: Notification) => void) | null = null;
  private lost: (() => void) | null = null;
  private threadConfig: Record<string, unknown> = {};
  private initialized = false;
  constructor(readonly cwd: string, private readonly binary = settingText("agents.codex.binary")?.trim() || "codex", private readonly env = process.env) {}

  async initialize(): Promise<void> {
    if (this.closing) throw new Error("Side chat executor closed");
    if (this.initialized) return;
    if (process.platform !== "darwin") throw new SideChatError(422, "PLATFORM_UNSUPPORTED", "消息旁聊目前仅支持本机 macOS Codex");
    const cwd = realpathSync(this.cwd);
    // Explicitly deny scratch writes even when :minimal grants them.
    if (["/private/tmp", "/private/var/tmp", "/System", "/Library", "/usr", "/bin", "/dev", "/private/etc"].some(root => cwd === root || cwd.startsWith(`${root}/`)))
      throw new SideChatError(422, "READ_SCOPE_UNSUPPORTED", "该目录无法落实旁聊的项目读取范围，请使用独立的本地项目目录");
    const filesystem = { ":minimal": "read", "/private/tmp": "deny", "/private/var/tmp": "deny", [cwd]: "read" };
    const overrides: Record<string, unknown> = {
      check_for_update_on_startup: false,
      default_permissions: this.profile,
      [`permissions.${this.profile}.filesystem`]: filesystem,
      [`permissions.${this.profile}.network.enabled`]: false,
      approval_policy: "never", web_search: "disabled", notify: [],
      "agents.enabled": false,
      "orchestrator.mcp.enabled": false, "orchestrator.skills.enabled": false, "shell_environment_policy.inherit": "none",
      "shell_environment_policy.set": { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" },
      "features.daemon_auto_start": false,
      ...Object.fromEntries(DISABLED.map(name => [`features.${name}`, false])),
    };
    const args = Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
    const env = { ...this.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RUNWEAVE_") || key === "TMUX" || key === "TMUX_PANE" || key.startsWith("CODEX_THREAD") || key.startsWith("CODEX_INTERNAL")) delete env[key];
    }
    const child = spawn(this.binary, [...args, "app-server", "--stdio"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exit = new Promise(resolve => child.once("close", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // Process output can include tool content. Never forward it to response or diagnostic logs.
    child.stderr.on("data", () => undefined);
    child.once("error", () => this.failed());
    child.once("close", () => this.failed());
    try {
      await this.request("initialize", { clientInfo: { name: "runweave_side_chat", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
      const read = await this.request("config/read", { cwd, includeLayers: false }) as { config: { mcp_servers?: Record<string, unknown> } };
      // The fork already contains the source instructions as history. Do not reload ancestor
      // project documents outside the read scope or turn them into fresh side-chat work.
      this.threadConfig = { ...overrides, project_doc_max_bytes: 0, mcp_servers: Object.fromEntries(Object.keys(read.config.mcp_servers ?? {}).map(name => [name, { enabled: false }])) };
      this.initialized = true;
    } catch (error) { await this.close(); throw error; }
  }
  read(threadId: string): Promise<{ thread: ProviderThread }> { return this.request("thread/read", { threadId, includeTurns: true }) as Promise<{ thread: ProviderThread }>; }
  async fork(threadId: string, lastTurnId: string, model?: string): Promise<ThreadResponse> {
    const result = await this.request("thread/fork", { ...this.options(), threadId, lastTurnId, model, ephemeral: false, deferGoalContinuation: true }) as ThreadResponse;
    this.assertPermissions(result);
    if (!result.thread.id || result.thread.id === threadId || result.thread.forkedFromId !== threadId || result.thread.ephemeral || result.thread.turns.at(-1)?.id !== lastTurnId || result.thread.turns.at(-1)?.status !== "completed")
      throw new SideChatError(503, "FORK_IDENTITY_UNCONFIRMED", "独立分支身份未确认");
    return result;
  }
  async resume(threadId: string, model?: string): Promise<void> {
    const result = await this.request("thread/resume", { ...this.options(), threadId, model }) as ThreadResponse;
    this.assertPermissions(result);
    if (result.thread.id !== threadId) throw new Error("Side chat identity changed");
  }
  start(threadId: string, turnId: string, text: string): Promise<{ turn: ProviderTurn }> {
    return this.request("turn/start", { threadId, environments: [{ environmentId: "local", cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd] }], clientUserMessageId: turnId, input: [{ type: "text", text }] }) as Promise<{ turn: ProviderTurn }>;
  }
  interrupt(threadId: string, turnId: string): Promise<unknown> { return this.request("turn/interrupt", { threadId, turnId }); }
  observe(onEvent: (event: Notification) => void, onLost: () => void): void { this.notification = onEvent; this.lost = onLost; }
  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    this.failed();
    child.stdin.end();
    child.kill("SIGTERM");
    const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500);
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exit, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Side chat process did not exit")), 2500);
      })]);
    } finally { clearTimeout(kill); clearTimeout(deadline); }
    this.child = null;
  }
  private options() { return { cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd], permissions: this.profile, approvalPolicy: "never", developerInstructions: BOUNDARY, config: this.threadConfig }; }
  private assertPermissions(result: ThreadResponse): void {
    assertLocalSideChatEnvironment(result.thread, this.cwd);
    if (result.approvalPolicy !== "never" || result.sandbox.type !== "readOnly" || result.sandbox.networkAccess !== false || result.activePermissionProfile?.id !== this.profile)
      throw new SideChatError(422, "PERMISSIONS_UNCONFIRMED", "旁聊只读权限未生效");
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || this.closing || !child.stdin.writable) return Promise.reject(new Error("Side chat executor unavailable"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Side chat RPC outcome unknown")); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => { if (error) this.failed(); });
    });
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) { this.failed(); this.child?.kill("SIGTERM"); return; }
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      try {
        const msg = JSON.parse(line) as Notification & { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer); this.pending.delete(msg.id);
            if (msg.error) pending.reject(new SideChatError(503, "PROVIDER_REJECTED", "Codex 拒绝了旁聊操作，请查看当前状态"));
            else pending.resolve(msg.result);
          } else if (msg.method) {
            // No auto-approval, client tool execution or permission escalation.
            this.child?.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: "Side chat forbids client tools and approvals" } })}\n`);
            this.lost?.();
          }
        } else this.notification?.(msg);
      } catch { /* Ignore non-protocol lines without logging their contents. */ }
    }
  }
  private failed(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Side chat executor lost; outcome unknown")); }
    this.pending.clear();
    if (!this.closing) this.lost?.();
  }
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function assertLocalSideChatEnvironment(thread: ProviderThread, cwd: string): void {
  const localPath = (value: string) => realpathSync(value.startsWith("file:") ? fileURLToPath(value) : value);
  const environments = thread.environments;
  if (!environments || environments.length !== 1 || environments[0]!.environmentId !== "local" ||
    localPath(environments[0]!.cwd) !== localPath(cwd) ||
    environments[0]!.runtimeWorkspaceRoots.some(root => localPath(root) !== localPath(cwd)))
    throw new SideChatError(422, "EXECUTION_HOST_UNCONFIRMED", "消息旁聊需要可确认的单一本地项目执行环境");
}
