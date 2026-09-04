import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const STARTUP_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 200;

async function probeTcp(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (ready: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function probeHttp(port: number, path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path,
        timeout: PROBE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resolve(
          response.statusCode !== undefined &&
            response.statusCode >= 200 &&
            response.statusCode <= 399,
        );
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

export async function waitForWorkspaceServiceReady(input: {
  port: number;
  healthCheckPath: string | null;
  signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new Error("Workspace service start aborted");
    const ready = input.healthCheckPath
      ? await probeHttp(input.port, input.healthCheckPath)
      : await probeTcp(input.port);
    if (ready) return;
    await delay(PROBE_INTERVAL_MS, undefined, { signal: input.signal });
  }
  throw new Error("Workspace service readiness timed out");
}
