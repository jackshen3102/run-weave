import net from "node:net";

const DEFAULT_CDP_PROXY_PORT = 9224;
const CDP_PROXY_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 50;

export { CDP_PROXY_HOST };

export function resolveCdpProxyPort(env: NodeJS.ProcessEnv): {
  port: number;
  strict: boolean;
} {
  const raw = env.BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT;
  if (raw === undefined || raw === "") {
    return { port: DEFAULT_CDP_PROXY_PORT, strict: false };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `[cdp-proxy] invalid BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT: ${raw}`,
    );
  }
  return { port: parsed, strict: true };
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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

    tester.listen(port, CDP_PROXY_HOST);
  });
}

export async function findAvailableCdpProxyPort(
  startPort: number,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = startPort + attempt;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `[cdp-proxy] failed to find available port from ${startPort}`,
  );
}
