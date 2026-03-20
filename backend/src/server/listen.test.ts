import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listenWithFallback } from "./listen";

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    await closeServer(probe);
    throw new Error("Failed to allocate free port");
  }
  const port = address.port;
  await closeServer(probe);
  return port;
}

describe("listenWithFallback", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => closeServer(server)));
    servers.length = 0;
  });

  it("listens on the preferred port when available", async () => {
    const startPort = await getFreePort();
    const server = http.createServer();
    servers.push(server);

    const chosenPort = await listenWithFallback(server, startPort, {
      host: "127.0.0.1",
    });

    expect(chosenPort).toBe(startPort);
  });

  it("retries next port when preferred port is in use", async () => {
    const startPort = await getFreePort();
    const blocker = http.createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => {
      blocker.listen(startPort, "127.0.0.1", () => resolve());
    });

    const server = http.createServer();
    servers.push(server);

    const chosenPort = await listenWithFallback(server, startPort, {
      host: "127.0.0.1",
      maxAttempts: 10,
    });

    expect(chosenPort).not.toBe(startPort);
    expect(chosenPort).toBeGreaterThan(startPort);
  });
});
