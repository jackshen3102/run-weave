import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class DevResourceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function controlEntry(): string {
  const runtime = path.dirname(fileURLToPath(import.meta.url));
  const packaged = path.join(runtime, "dev-resources/control.cjs");
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(
    new URL("../../../scripts/dev-resources/control.mjs", import.meta.url),
  );
  if (existsSync(source)) return source;
  throw new DevResourceError(503, "开发资源控制能力尚未安装");
}

export async function runDevResourceControl<T>(
  payload: Record<string, unknown>,
  onSpawn?: (pid: number) => Promise<void>,
): Promise<T> {
  const entry = controlEntry();
  return new Promise<T>((resolve, reject) => {
    // This authenticated controller inspects multiple Sessions, rather than starting a child in its caller's Session.
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    };
    delete environment.RUNWEAVE_DEV_SESSION_ID;
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "ignore"],
      env: environment,
    });
    let stdout = "";
    let excessive = false;
    const deadline =
      payload.command === "inspect"
        ? setTimeout(() => {
            child.kill();
            reject(new DevResourceError(503, "资源读取超时，请手动刷新"));
          }, 60_000)
        : null;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) excessive = true;
      else stdout += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", () => {
      if (deadline) clearTimeout(deadline);
      try {
        if (excessive) throw new Error("Control response exceeds size limit");
        const result = JSON.parse(stdout) as {
          ok: boolean;
          value: T;
          status?: number;
          message?: string;
        };
        if (!result.ok)
          throw new DevResourceError(
            result.status ?? 200,
            result.message ?? "资源清理未完成",
          );
        resolve(result.value);
      } catch (error) {
        reject(error);
      }
    });
    child.once("spawn", () => {
      void (async () => {
        if (onSpawn && child.pid) await onSpawn(child.pid);
        child.stdin.end(JSON.stringify(payload));
      })().catch((error) => {
        child.stdin.end();
        reject(error);
      });
    });
  });
}
