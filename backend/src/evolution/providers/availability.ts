import { settingText } from "@runweave/config-node";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EvolutionProviderAvailability } from "@runweave/shared/evolution";
import { resolveProviderBinary } from "./launch";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

interface ProviderCommand {
  provider: EvolutionProviderAvailability["provider"];
  binary: string;
}

export class EvolutionProviderAvailabilityService {
  private cached:
    | { expiresAt: number; value: EvolutionProviderAvailability[] }
    | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async list(): Promise<EvolutionProviderAvailability[]> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value.map((item) => ({ ...item }));
    }
    const commands: ProviderCommand[] = [
      {
        provider: "codex",
        binary: settingText("agents.codex.binary")?.trim() || "codex",
      },
      {
        provider: "trae",
        binary: settingText("agents.traex.binary")?.trim() || "traex",
      },
    ];
    const value = await Promise.all(commands.map((command) => probe(command, this.env)));
    this.cached = { expiresAt: now + CACHE_TTL_MS, value };
    return value.map((item) => ({ ...item }));
  }
}

async function probe(
  command: ProviderCommand,
  env: NodeJS.ProcessEnv,
): Promise<EvolutionProviderAvailability> {
  const checkedAt = new Date().toISOString();
  const binary = resolveProviderBinary(command.provider, command.binary, env);
  const versionResult = await runProbe(binary, ["--version"], env);
  if (!versionResult.ok) {
    return {
      provider: command.provider,
      available: false,
      binaryAvailable: false,
      authenticated: false,
      version: null,
      reason: versionResult.reason,
      checkedAt,
    };
  }
  const authResult = await runProbe(binary, ["login", "status"], env);
  return {
    provider: command.provider,
    available: authResult.ok,
    binaryAvailable: true,
    authenticated: authResult.ok,
    version: firstLine(versionResult.output),
    reason: authResult.ok ? null : authResult.reason,
    checkedAt,
  };
}

async function runProbe(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync(binary, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env,
    });
    return {
      ok: true,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return {
      ok: false,
      reason:
        code === "ENOENT"
          ? "provider_binary_not_found"
          : code === "ETIMEDOUT"
            ? "provider_status_timeout"
            : "provider_not_authenticated",
    };
  }
}

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/u).find((item) => item.trim().length > 0);
  return line?.trim().slice(0, 200) || null;
}
