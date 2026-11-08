import { spawn } from "node:child_process";
import path from "node:path";
import { settingText } from "@runweave/config-node";
import { z } from "zod";
import { resolveExecutableFromPath } from "../tmux/internals";
import { CodeReviewError } from "./store";

const hookList = z.object({ data: z.array(z.object({
  cwd: z.string(),
  hooks: z.array(z.object({ key: z.string(), enabled: z.boolean(), isManaged: z.boolean(), trustStatus: z.string() })),
  errors: z.array(z.unknown()), warnings: z.array(z.string()),
})) });

/** Metadata only: never starts a thread, reads history or persists hook trust. */
async function listReviewerHooks(cwd: string, command: string): Promise<unknown> {
  const child = spawn(command, ["app-server", "--listen", "stdio://"], {
    cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  // Drain diagnostics without placing local config, hook commands or credentials in logs.
  child.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let initialized = false;
      let buffer = "";
      let bytes = 0;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new CodeReviewError(503, "reviewer_hooks_unavailable", "无法核验 Reviewer 的 Hooks，未启动交互进程"));
      };
      const write = (message: unknown) => { child.stdin.write(JSON.stringify(message) + "\n"); };
      child.on("error", fail); child.on("exit", fail); child.stdin.on("error", fail);
      timer = setTimeout(fail, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail(); return; }
        buffer += chunk.toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch { fail(); return; }
          if (response.id !== 1 && response.id !== 2) continue;
          if (response.error) { fail(); return; }
          if (response.id === 1 && !initialized) {
            initialized = true;
            write({ method: "initialized" });
            write({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
          } else if (response.id === 2 && initialized) {
            settled = true; resolve(response.result); return;
          }
        }
      });
      write({ id: 1, method: "initialize", params: {
        clientInfo: { name: "runweave_review_hook_check", version: "1" }, capabilities: { experimentalApi: true },
      } });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("close", () => { clearTimeout(killTimer); resolve(); });
        child.kill("SIGTERM");
      });
    }
  }
}

/** Codex 0.166 prompts even for disabled, changed plugin hooks. Skip that UI only
 * after proving that every enabled hook is already trusted or administrator-managed.
 * The flag never enables the disabled hooks and does not persist trust decisions. */
export async function prepareReviewerLaunch(cwd: string): Promise<{ command: string; args: string[] }> {
  const resolved = resolveExecutableFromPath(settingText("agents.codex.binary")?.trim() || "codex", process.env);
  if (!resolved.includes(path.sep))
    throw new CodeReviewError(503, "reviewer_hooks_unavailable", "无法解析 Reviewer 的 Codex 可执行文件，未启动交互进程");
  const command = path.resolve(cwd, resolved);
  const parsed = hookList.safeParse(await listReviewerHooks(cwd, command));
  if (!parsed.success || parsed.data.data.length !== 1 || parsed.data.data[0]!.cwd !== cwd ||
      parsed.data.data[0]!.errors.length || parsed.data.data[0]!.warnings.length)
    throw new CodeReviewError(503, "reviewer_hooks_unavailable", "Reviewer Hooks 配置不完整，未启动交互进程");
  const unsafe = parsed.data.data[0]!.hooks.some((hook) => hook.enabled && !hook.isManaged && hook.trustStatus !== "trusted");
  if (unsafe) throw new CodeReviewError(409, "reviewer_hooks_untrusted", "存在已启用但尚未信任的 Hooks，未自动授权或启动 Reviewer");
  return { command, args: ["--dangerously-bypass-hook-trust"] };
}
