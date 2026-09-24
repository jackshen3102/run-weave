import { spawn } from "node:child_process";

export function startManualPortForward(host: string, port: number) {
  const marker = "runweave-forward-ready";
  const child = spawn("ssh", [
    "-N", "-T", "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes",
    // OpenSSH runs LocalCommand after authentication and forwarding setup.
    "-o", "PermitLocalCommand=yes", "-o", `LocalCommand=echo ${marker}`,
    "-L", `127.0.0.1:${port}:127.0.0.1:${port}`,
    host,
  ], { stdio: "pipe" });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let stdout = "";
    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (reason) {
        child.kill("SIGTERM");
        reject(new Error(`端口 ${port} 转发失败，请检查本地端口是否被占用及 SSH 连接：${reason}`));
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => finish("等待 SSH 建立转发超时"), 15_000);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-2048);
      if (stdout.split(/\r?\n/).includes(marker)) finish();
    });
    child.once("error", (error) => finish(error.message));
    child.once("exit", () => finish(stderr.trim() || "SSH 连接已结束"));
  });
  return { child, ready };
}
