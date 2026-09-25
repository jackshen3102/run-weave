import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
export interface SshProcess {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  stop(): Promise<void>;
}
export function startSsh(host: string, forwards: string[] = []): SshProcess {
  const marker = "runweave-tunnel-ready";
  const child = spawn(
    "ssh",
    [
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "PermitLocalCommand=yes",
      "-o",
      `LocalCommand=echo ${marker}`,
      ...forwards,
      host,
    ],
    { stdio: "pipe" },
  );
  let stdout = "",
    stderr = "";
  const ready = new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGTERM");
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("SSH_TIMEOUT: SSH 建立连接超时")),
      15000,
    );
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-4096);
      if (stdout.split(/\r?\n/).includes(marker)) finish();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4096);
    });
    child.once("error", () =>
      finish(new Error("SSH_START_FAILED: 无法启动系统 SSH")),
    );
    child.once("exit", () =>
      finish(
        new Error(
          /address already in use|cannot listen to port/i.test(stderr)
            ? "LOCAL_PORT_IN_USE: 本机端口已被占用，请释放端口或修改服务端口"
            : /permission denied|host key verification failed|REMOTE HOST IDENTIFICATION/i.test(
                  stderr,
                )
              ? "SSH_AUTH_FAILED: SSH 身份或主机密钥验证失败，请检查本机 SSH 配置"
              : "SSH_DISCONNECTED: SSH 连接中断",
        ),
      ),
    );
  });
  // Callers attach immediately, but cancellation may happen before they await readiness.
  void ready.catch(() => {});
  return {
    child,
    ready,
    stop: async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}
export async function freePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("PORT_ALLOCATION_FAILED"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
export async function remoteFreePort(host: string): Promise<number> {
  const command = `node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'`;
  const child = spawn("ssh", [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    host,
    command,
  ]);
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-2048);
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, 15000);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const port = Number(output.trim());
  if (code !== 0 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BROWSER_PORT_FAILED: 无法创建远端浏览器通道");
  return port;
}
