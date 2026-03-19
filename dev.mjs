import net from "node:net";
import { spawn } from "node:child_process";

const DEFAULT_BACKEND_PORT = Number(process.env.PORT ?? 5001);
const DEFAULT_FRONTEND_PORT = Number(process.env.VITE_DEV_PORT ?? 5173);

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, "127.0.0.1");
  });
}

async function resolvePort(startPort, reservedPorts = new Set()) {
  let port = startPort;
  while (reservedPorts.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }
  return port;
}

function run() {
  return (async () => {
    const reservedPorts = new Set();
    const backendPort = await resolvePort(DEFAULT_BACKEND_PORT, reservedPorts);
    reservedPorts.add(backendPort);
    const frontendPort = await resolvePort(
      DEFAULT_FRONTEND_PORT,
      reservedPorts,
    );

    if (backendPort !== DEFAULT_BACKEND_PORT) {
      console.log(
        `[dev] backend preferred port ${DEFAULT_BACKEND_PORT} unavailable, using ${backendPort}`,
      );
    }

    if (frontendPort !== DEFAULT_FRONTEND_PORT) {
      console.log(
        `[dev] frontend preferred port ${DEFAULT_FRONTEND_PORT} unavailable, using ${frontendPort}`,
      );
    }

    const backend = spawn("pnpm", ["-C", "./backend", "dev"], {
      env: {
        ...process.env,
        PORT: String(backendPort),
        FRONTEND_ORIGIN: `http://localhost:${frontendPort},http://127.0.0.1:${frontendPort}`,
      },
      stdio: "inherit",
    });

    const frontend = spawn("pnpm", ["-C", "./frontend", "dev"], {
      env: {
        ...process.env,
        VITE_PROXY_TARGET: `http://localhost:${backendPort}`,
        VITE_DEV_PORT: String(frontendPort),
        VITE_API_BASE_URL: "",
      },
      stdio: "inherit",
    });

    let shuttingDown = false;

    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      backend.kill("SIGTERM");
      frontend.kill("SIGTERM");
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const handleExit = (name, code, signal) => {
      if (shuttingDown) {
        return;
      }

      console.log(`[dev] ${name} exited`, { code, signal });
      shutdown();
      process.exit(code ?? 1);
    };

    backend.on("exit", (code, signal) => handleExit("backend", code, signal));
    frontend.on("exit", (code, signal) => handleExit("frontend", code, signal));

    console.log(
      `[dev] frontend: http://localhost:${frontendPort} | backend: http://localhost:${backendPort}`,
    );
  })();
}

run().catch((error) => {
  console.error("[dev] failed to start", error);
  process.exit(1);
});
