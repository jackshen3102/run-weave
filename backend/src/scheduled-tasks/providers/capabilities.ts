import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ScheduledTaskCapabilities } from "@runweave/shared/scheduled-tasks";
import { CodexScheduledTaskProvider } from "./codex";
import type { ScheduledProviderAdapter } from "./types";

const execFileAsync = promisify(execFile);

export async function probeScheduledProviders(env: NodeJS.ProcessEnv): Promise<{
  capabilities: ScheduledTaskCapabilities["providers"];
  adapters: Map<string, ScheduledProviderAdapter>;
}> {
  const codexBinary = env.RUNWEAVE_CODEX_BIN?.trim() || "codex";
  let codexAvailable = false;
  let codexReason: string | undefined;
  try {
    await execFileAsync(codexBinary, ["--version"], { timeout: 10_000, env });
    await execFileAsync(codexBinary, ["login", "status"], {
      timeout: 10_000,
      env,
    });
    codexAvailable = true;
  } catch {
    codexReason = "Codex CLI is unavailable or not authenticated";
  }
  const adapters = new Map<string, ScheduledProviderAdapter>();
  if (codexAvailable)
    adapters.set("codex", new CodexScheduledTaskProvider(codexBinary));
  return {
    adapters,
    capabilities: [
      {
        provider: "codex",
        available: codexAvailable,
        ...(codexReason ? { reason: codexReason } : {}),
      },
      {
        provider: "trae",
        available: false,
        reason:
          "TraeX persistent background execution has not passed the recovery gate",
      },
      {
        provider: "pi",
        available: false,
        reason:
          "Pi persistent background execution has not passed the recovery gate",
      },
    ],
  };
}
