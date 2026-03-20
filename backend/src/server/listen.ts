import type http from "node:http";
import net from "node:net";

interface ListenWithFallbackOptions {
  host?: string;
  maxAttempts?: number;
}

async function isPortAvailable(port: number, host?: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const tester = net.createServer();

    const cleanup = (): void => {
      tester.removeAllListeners("error");
      tester.removeAllListeners("listening");
    };

    tester.once("error", () => {
      cleanup();
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => {
        cleanup();
        resolve(true);
      });
    });

    try {
      if (host) {
        tester.listen(port, host);
      } else {
        tester.listen(port);
      }
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

async function listenOnPort(
  server: http.Server,
  port: number,
  host?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      if (host) {
        server.listen(port, host);
      } else {
        server.listen(port);
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function listenWithFallback(
  server: http.Server,
  startPort: number,
  options: ListenWithFallbackOptions = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 50;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = startPort + attempt;

    if (!(await isPortAvailable(port, options.host))) {
      continue;
    }

    try {
      await listenOnPort(server, port, options.host);
      return port;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to bind server after ${maxAttempts} attempts starting from port ${startPort}`,
  );
}
