import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface SshProcess {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  stop(): Promise<void>;
}
export function startSsh(
  host: string,
  forwards: string[] = [],
  command?: string,
): SshProcess {
  const marker = "runweave-tunnel-ready";
  const socketDir = forwards.length
    ? mkdtempSync(path.join(os.tmpdir(), "rw-ssh-"))
    : null;
  const socketPath = socketDir ? path.join(socketDir, "s") : null;
  const child = spawn(
    "ssh",
    [
      ...(command ? [] : ["-N"]),
      "-T",
      ...(socketPath ? ["-M", "-S", socketPath, "-o", "ControlPersist=no"] : []),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ConnectTimeout=10",
      "-o",
      `PermitLocalCommand=${command ? "no" : "yes"}`,
      "-o",
      `LocalCommand=echo ${marker}`,
      ...forwards,
      host,
      ...(command ? [command] : []),
    ],
    { stdio: "pipe" },
  );
  if (socketDir)
    child.once("close", () => {
      try {
        rmSync(socketDir, { recursive: true, force: true });
      } catch {
        /* A cleanup failure must not crash the desktop process. */
      }
    });
  let stdout = "",
    stderr = "";
  let control: ChildProcessWithoutNullStreams | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        control?.kill("SIGTERM");
        child.kill("SIGTERM");
        reject(error);
      } else resolve();
    };
    const applyForwards = () => {
      if (!socketPath) {
        finish();
        return;
      }
      // ClearAllForwardings also clears command-line -L/-R; add only our forwards
      // through this private master socket, without rereading the user's alias.
      control = spawn(
        "ssh",
        [
          "-F", "/dev/null", "-S", socketPath, "-O", "forward",
          "-o", "ExitOnForwardFailure=yes", ...forwards, host,
        ],
        { stdio: "pipe" },
      );
      control.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4096);
      });
      control.once("error", () =>
        finish(new Error("SSH_START_FAILED: 无法设置 SSH 转发")));
      control.once("exit", (code) => {
        if (code === 0) finish();
        else
          finish(new Error(
            /address already in use|cannot listen to port/i.test(stderr)
              ? "LOCAL_PORT_IN_USE: 本机端口已被占用，请释放端口或修改服务端口"
              : "SSH_FORWARD_FAILED: 无法设置 SSH 转发",
          ));
      });
    };
    const timer = setTimeout(
      () => finish(new Error("SSH_TIMEOUT: SSH 建立连接超时")),
      15000,
    );
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-4096);
      if (stdout.split(/\r?\n/).includes(marker) && !control && !done)
        applyForwards();
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
          /address already in use|cannot listen to port|EADDRINUSE|remote port forwarding failed/i.test(
            stderr,
          )
            ? "PORT_IN_USE: 通道端口已被占用，请修改端口或稍后重试"
            : /permission denied|host key verification failed|REMOTE HOST IDENTIFICATION/i.test(
                  stderr,
                )
              ? "SSH_AUTH_FAILED: SSH 身份或主机密钥验证失败，请检查本机 SSH 配置"
              : /EADDRNOTAVAIL/.test(stderr)
                ? "RELAY_ADDRESS_INVALID: 服务器没有此内网地址，请修改中转服务器地址"
                : /node:.*not found|node:.*command not found/i.test(stderr)
                  ? "RELAY_NODE_MISSING: 中转服务器需要安装 Node.js，并可通过 SSH 执行 node"
                  : "SSH_DISCONNECTED: 服务器不可达或连接中断，请检查网络、VPN 和 SSH 配置",
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
      control?.kill("SIGTERM");
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
    "ClearAllForwardings=yes",
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
    throw new Error(
      "REMOTE_PORT_FAILED: 无法分配远端通道端口，请确认 SSH 可连接且服务器可执行 node",
    );
  return port;
}
