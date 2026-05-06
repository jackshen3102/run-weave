import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { CliError } from "../errors.js";
import { writeOutput } from "../output/format.js";

const DEFAULT_TARGET_URL = "http://localhost:5001";
const DEFAULT_TIMEOUT_MS = 90_000;
const QUICK_TUNNEL_URL_PATTERN =
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s"',)\]])/;

type TokenSource = "option" | "env";

interface TunnelProcess {
  pid?: number;
  stdout?: Readable | null;
  stderr?: Readable | null;
  kill?: (signal?: NodeJS.Signals) => boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

interface TunnelLauncher {
  spawn(command: string, args: string[]): TunnelProcess;
}

interface TunnelIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
}

const defaultLauncher: TunnelLauncher = {
  spawn(command, args) {
    return spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as TunnelProcess;
  },
};

export async function runTunnelCommand(
  subcommand: string | undefined,
  args: string[],
  io: TunnelIo,
  launcher: TunnelLauncher = defaultLauncher,
): Promise<void> {
  if (subcommand !== "start") {
    throw new CliError(
      "Usage: rw tunnel start [--url http://localhost:5001] [--token <token>]",
      2,
    );
  }

  const parsed = parseArgs(args, new Set(["json", "plain", "skip-check"]));
  const mode = resolveOutputMode(parsed.options);
  const targetUrl = normalizeTargetUrl(
    getStringOption(parsed.options, "url") ??
      getStringOption(parsed.options, "target-url") ??
      io.env.RUNWEAVE_TUNNEL_TARGET_URL ??
      DEFAULT_TARGET_URL,
  );
  const token = resolveTunnelToken(parsed.options, io.env);
  const timeoutMs = parseTimeoutMs(getStringOption(parsed.options, "timeout-ms"));

  if (parsed.options["skip-check"] !== true) {
    await verifyTunnelTokenProtection(targetUrl, token.value);
  }

  const launch = buildCloudflaredLaunch(parsed.options, io.env, targetUrl);
  const child = launcher.spawn(launch.command, launch.args);
  const started = await waitForTunnelUrl(child, timeoutMs);
  const publicUrl = appendTokenToUrl(started.url, token.value);
  const payload = {
    publicUrl,
    tunnelUrl: started.url,
    targetUrl,
    token: token.value,
    tokenSource: token.source,
    pid: child.pid ?? null,
  };

  if (mode === "json") {
    writeOutput(io.stdout, mode, payload);
  } else {
    io.stdout.write(`Public URL: ${publicUrl}\n`);
    io.stdout.write(`Tunnel URL: ${started.url}\n`);
    io.stdout.write(`Target URL: ${targetUrl}\n`);
    io.stdout.write("Keep this command running while the tunnel is needed.\n");
  }

  await waitForProcessClose(child);
}

function resolveTunnelToken(
  options: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
): { value: string; source: TokenSource } {
  const optionToken = getStringOption(options, "token")?.trim();
  if (optionToken) {
    return { value: optionToken, source: "option" };
  }

  const envToken = env.RUNWEAVE_TUNNEL_TOKEN?.trim();
  if (envToken) {
    return { value: envToken, source: "env" };
  }

  throw new CliError(
    "Missing tunnel token. Set RUNWEAVE_TUNNEL_TOKEN or pass --token with the same token used to start the backend.",
    2,
  );
}

function normalizeTargetUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new CliError(`Invalid tunnel target URL: ${rawUrl}`, 2);
  }
}

function parseTimeoutMs(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_TIMEOUT_MS;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError("--timeout-ms must be a positive integer", 2);
  }
  return value;
}

function buildCloudflaredLaunch(
  options: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  targetUrl: string,
): { command: string; args: string[] } {
  const explicitCommand =
    getStringOption(options, "cloudflared-command") ??
    env.RUNWEAVE_CLOUDFLARED_COMMAND;

  const tunnelArgs = [
    "tunnel",
    "--protocol",
    "http2",
    "--url",
    targetUrl,
  ];

  if (explicitCommand?.trim()) {
    return {
      command: explicitCommand.trim(),
      args: tunnelArgs,
    };
  }

  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "--package=cloudflared", "cloudflared", ...tunnelArgs],
  };
}

export function appendTokenToUrl(publicUrl: string, token: string): string {
  const parsed = new URL(publicUrl);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

function extractQuickTunnelUrl(content: string): string | null {
  return QUICK_TUNNEL_URL_PATTERN.exec(content)?.[0] ?? null;
}

async function verifyTunnelTokenProtection(
  targetUrl: string,
  token: string,
): Promise<void> {
  const healthUrl = `${targetUrl}/health`;
  const forwardedHeaders = { "X-Forwarded-For": "203.0.113.10" };
  let withoutToken: Response;
  let withToken: Response;

  try {
    [withoutToken, withToken] = await Promise.all([
      fetch(healthUrl, { headers: forwardedHeaders }),
      fetch(`${healthUrl}?token=${encodeURIComponent(token)}`, {
        headers: forwardedHeaders,
      }),
    ]);
  } catch (error) {
    throw new CliError(
      `Cannot reach Runweave backend at ${targetUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      1,
    );
  }

  if (!withToken.ok) {
    throw new CliError(
      `Runweave backend did not accept the tunnel token at ${healthUrl}. Start it with RUNWEAVE_TUNNEL_TOKEN set to the same value.`,
      1,
    );
  }

  if (withoutToken.status !== 401) {
    throw new CliError(
      `Runweave backend at ${targetUrl} is reachable without a tunnel token. Start it with RUNWEAVE_TUNNEL_TOKEN, or pass --skip-check to tunnel anyway.`,
      1,
    );
  }
}

function waitForTunnelUrl(
  child: TunnelProcess,
  timeoutMs: number,
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill?.("SIGTERM");
      reject(new CliError("Timed out waiting for Cloudflare tunnel URL", 1));
    }, timeoutMs);

    const settleResolve = (url: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ url });
    };

    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const handleChunk = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const url = extractQuickTunnelUrl(output);
      if (url) {
        settleResolve(url);
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.on("error", settleReject);
    child.on("close", (code, signal) => {
      if (!settled) {
        settleReject(
          new CliError(
            `cloudflared exited before printing a tunnel URL (${signal ?? code ?? "unknown"})`,
            1,
          ),
        );
      }
    });
  });
}

function waitForProcessClose(child: TunnelProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code && code !== 0) {
        reject(new CliError(`cloudflared exited with code ${code}`, code));
        return;
      }
      if (signal && signal !== "SIGINT" && signal !== "SIGTERM") {
        reject(new CliError(`cloudflared exited on signal ${signal}`, 1));
        return;
      }
      resolve();
    });
  });
}
