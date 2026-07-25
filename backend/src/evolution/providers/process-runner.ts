import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionProviderName,
  EvolutionProviderRequest,
  EvolutionProviderResult,
} from "./types";

const TERMINATION_GRACE_MS = 2_000;
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "TRAE_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export async function runProviderProcess(params: {
  provider: EvolutionProviderName;
  binary: string;
  args: string[];
  request: EvolutionProviderRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<EvolutionProviderResult> {
  const startedAt = Date.now();
  const outputFile = path.join(
    params.request.workingDirectory,
    "last-message.json",
  );
  const child = spawn(
    params.binary,
    [...params.args, "--output-last-message", outputFile, "-"],
    {
      cwd: params.request.workingDirectory,
      env: providerEnvironment(params.env ?? process.env, params.request),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  const output = collectOutput(child, params.request.maxOutputBytes);
  const termination = createTermination(child);
  const timeout = setTimeout(
    () => termination("provider_timeout"),
    params.request.maxWallTimeMs,
  );
  timeout.unref();
  const onAbort = (): void => termination("provider_cancelled");
  params.request.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.end(params.request.prompt);

  try {
    const [exit, captured] = await Promise.all([waitForExit(child), output]);
    if (exit.error) throw exit.error;
    if (exit.code !== 0) {
      throw new Error(
        exit.terminationReason ??
          (captured.stderr.includes("schema")
            ? "provider_output_schema_rejected"
            : "provider_exit_nonzero"),
      );
    }
    const rawResult = await readFile(outputFile, "utf8").catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      throw new Error("provider_output_invalid_json");
    }
    return {
      provider: params.provider,
      durationMs: Date.now() - startedAt,
      events: parseJsonLines(captured.stdout),
      output: parsed,
    };
  } finally {
    clearTimeout(timeout);
    params.request.signal?.removeEventListener("abort", onAbort);
  }
}

function providerEnvironment(
  source: NodeJS.ProcessEnv,
  request: EvolutionProviderRequest,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  if (request.mcp) {
    env.RUNWEAVE_EVOLUTION_MCP_TOKEN = request.mcp.bearerToken;
  }
  return env;
}

function collectOutput(
  child: ChildProcess,
  maxBytes: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new Error("provider_output_limit_exceeded"));
        terminateProcessGroup(child, "SIGTERM");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("close", () => resolve({ stdout, stderr }));
    child.on("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  error?: Error;
  terminationReason?: string;
}> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => {
      resolve({
        code,
        terminationReason: terminationReasons.get(child),
      });
    });
  });
}

const terminationReasons = new WeakMap<ChildProcess, string>();

function createTermination(child: ChildProcess): (reason: string) => void {
  return (reason) => {
    if (child.exitCode !== null || terminationReasons.has(child)) return;
    terminationReasons.set(child, reason);
    terminateProcessGroup(child, "SIGTERM");
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) terminateProcessGroup(child, "SIGKILL");
    }, TERMINATION_GRACE_MS);
    forceTimer.unref();
  };
}

function terminateProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function parseJsonLines(value: string): unknown[] {
  return value.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}
