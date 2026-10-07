import { spawn } from "node:child_process";
import type { SupervisionHookRequest } from "@runweave/shared/task-supervision";
import { SupervisionError } from "./errors";

/** Reproduce only configuration arguments, never a turn, prompt or remote executor. */
function configArgs(args: string[]): string[] {
  const retained = new Set([
    "-c",
    "--config",
    "-p",
    "--profile",
    "--enable",
    "--disable",
  ]);
  const ignored = new Set([
    "-m",
    "--model",
    "-C",
    "--cd",
    "--add-dir",
    "-i",
    "--image",
    "--local-provider",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
  ]);
  const flags = new Set([
    "--no-alt-screen",
    "--no-daemon",
    "--search",
    "--oss",
    "--strict-config",
    "--yolo",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
  ]);
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === "resume" || value === "fork" || value === "--") break;
    const flag = value.split("=", 1)[0]!;
    if (retained.has(flag) || ignored.has(flag)) {
      const argument = value.includes("=") ? null : args[++i];
      if (argument === undefined)
        throw new SupervisionError("执行器配置参数不完整。", 422);
      if (retained.has(flag))
        result.push(value, ...(argument === null ? [] : [argument]));
    } else if (!flags.has(value))
      throw new SupervisionError(
        "当前执行器启动参数无法安全核对配置，请使用标准 Codex 入口。",
        422,
      );
  }
  return result;
}
export async function probeExecutorConfig(
  context: NonNullable<SupervisionHookRequest["executionConfig"]>,
  threadId: string,
) {
  const child = spawn(
    context.binary,
    [...configArgs(context.args), "app-server"],
    {
      cwd: context.cwd,
      env: { ...process.env, CODEX_HOME: context.home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  let buffer = "";
  const fail = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("无法读取原执行器配置。"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("close", fail);
  child.stdin.on("error", fail);
  child.stderr.resume();
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    if (buffer.length > 2_000_000) {
      fail();
      child.kill();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line) as {
          id: number;
          result?: unknown;
          error?: { message: string };
        };
        const waiter = pending.get(reply.id);
        if (!waiter) continue;
        pending.delete(reply.id);
        if (reply.error) waiter.reject(new Error(reply.error.message));
        else waiter.resolve(reply.result);
      } catch {
        /* Ignore diagnostics. */
      }
    }
  });
  const timer = setTimeout(() => {
    fail();
    child.kill();
  }, 10_000);
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await call("initialize", {
      clientInfo: { name: "runweave_task_config_probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    const goal = await call("thread/goal/get", { threadId });
    const hooks = await call("hooks/list", { cwds: [context.cwd] });
    return {
      goal,
      hooks,
      bypassTrust: context.args.includes("--dangerously-bypass-hook-trust"),
    };
  } finally {
    clearTimeout(timer);
    fail();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
