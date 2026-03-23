import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ENTRY = path.join(ROOT_DIR, "backend", "dist", "index.js");
const FRONTEND_INDEX = path.join(ROOT_DIR, "frontend", "dist", "index.html");
const BACKEND_ENV_FILE = path.join(ROOT_DIR, "backend", ".env");

function readCliOption(args, optionName) {
  const longOption = `--${optionName}`;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current == null) {
      continue;
    }

    if (current === longOption) {
      return args[index + 1];
    }

    if (current.startsWith(`${longOption}=`)) {
      return current.slice(longOption.length + 1);
    }
  }

  return undefined;
}

function resolveBackendArgs() {
  const delimiterIndex = process.argv.indexOf("--");
  if (delimiterIndex >= 0) {
    return process.argv.slice(delimiterIndex + 1);
  }

  return process.argv.slice(2);
}

function parsePort(rawValue, fallbackPort) {
  if (!rawValue) {
    return fallbackPort;
  }

  const parsedPort = Number(rawValue.trim());
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid port value: ${JSON.stringify(rawValue)}`);
  }

  return parsedPort;
}

function removeCliOption(args, optionName) {
  const longOption = `--${optionName}`;
  const normalizedArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current == null) {
      continue;
    }

    if (current === longOption) {
      index += 1;
      continue;
    }

    if (current.startsWith(`${longOption}=`)) {
      continue;
    }

    normalizedArgs.push(current);
  }

  return normalizedArgs;
}

function resolveStartTarget(backendArgs) {
  const cliPort = readCliOption(backendArgs, "port")?.trim();
  const envPort = process.env.PORT?.trim();
  const preferredPort = parsePort(cliPort ?? envPort, 5000);

  const cliHost = readCliOption(backendArgs, "host")?.trim();
  const envHost = process.env.HOST?.trim();
  const host = cliHost || envHost || "0.0.0.0";
  return { preferredPort, host };
}

function resolveLocalHost(bindHost) {
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return "localhost";
  }

  if (bindHost === "127.0.0.1") {
    return "localhost";
  }

  return bindHost;
}

function resolveNetworkHost(bindHost) {
  if (bindHost === "localhost" || bindHost === "127.0.0.1") {
    return null;
  }

  if (bindHost !== "0.0.0.0" && bindHost !== "::") {
    return bindHost;
  }

  const interfaces = os.networkInterfaces();
  for (const records of Object.values(interfaces)) {
    if (!records) {
      continue;
    }

    for (const record of records) {
      if (record.family === "IPv4" && !record.internal) {
        return record.address;
      }
    }
  }

  return null;
}

async function isPortAvailable(port, host) {
  return await new Promise((resolve) => {
    const tester = net.createServer();

    const cleanup = () => {
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
      tester.listen({ port, host });
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

async function resolveAvailablePort(startPort, host) {
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = startPort + attempt;
    if (await isPortAvailable(candidatePort, host)) {
      return candidatePort;
    }
  }

  throw new Error(
    `Failed to find available port after ${maxAttempts} attempts starting from port ${startPort}`,
  );
}

async function runPnpmCommand(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(
        new Error(
          `pnpm ${args.join(" ")} failed (code=${code}, signal=${signal})`,
        ),
      );
    });
  });
}

function ensureBuildArtifacts() {
  if (!existsSync(BACKEND_ENTRY)) {
    throw new Error(`Missing backend build output: ${BACKEND_ENTRY}`);
  }

  if (!existsSync(FRONTEND_INDEX)) {
    throw new Error(`Missing frontend build output: ${FRONTEND_INDEX}`);
  }
}

async function startBackendProcess(backendArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["-C", "./backend", "start", "--", ...backendArgs],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV ?? "production",
          DOTENV_CONFIG_PATH:
            process.env.DOTENV_CONFIG_PATH ?? BACKEND_ENV_FILE,
        },
        stdio: "inherit",
      },
    );

    const forwardSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };

    const handleSigint = () => {
      forwardSignal("SIGINT");
    };

    const handleSigterm = () => {
      forwardSignal("SIGTERM");
    };

    const cleanup = () => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    };

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve(undefined);
        return;
      }

      reject(
        new Error(`backend exited (code=${code}, signal=${signal ?? "none"})`),
      );
    });
  });
}

async function run() {
  await runPnpmCommand(["build"]);
  ensureBuildArtifacts();
  const backendArgs = resolveBackendArgs();
  const target = resolveStartTarget(backendArgs);
  const resolvedPort = await resolveAvailablePort(
    target.preferredPort,
    target.host,
  );
  const normalizedBackendArgs = [
    ...removeCliOption(backendArgs, "port"),
    "--port",
    String(resolvedPort),
  ];
  const localHost = resolveLocalHost(target.host);
  const networkHost = resolveNetworkHost(target.host);

  console.log(`  ➜  Local:   http://${localHost}:${resolvedPort}/`);
  if (networkHost) {
    console.log(`  ➜  Network: http://${networkHost}:${resolvedPort}/`);
  }

  await startBackendProcess(normalizedBackendArgs);
}

run().catch((error) => {
  console.error("[start] failed", error);
  process.exit(1);
});
