import { settingText } from "@runweave/config-node";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ScheduledExecutionPolicy,
  ScheduledTaskCapabilities,
} from "@runweave/shared/scheduled-tasks";
import { CodexScheduledTaskProvider } from "./codex";
import type { ScheduledProviderAdapter } from "./types";

const execFileAsync = promisify(execFile);

export function detectCodexScheduledFeatures(help: string): {
  autoReview: boolean;
  fullAccess: boolean;
} {
  return {
    autoReview: help.includes("--approve-for-me"),
    fullAccess: help.includes("danger-full-access"),
  };
}

export function codexScheduledExecutionPolicies(
  help: string,
): ScheduledExecutionPolicy[] {
  const features = detectCodexScheduledFeatures(help);
  return [
    "sandbox",
    ...(features.autoReview ? (["auto-review"] as const) : []),
    ...(features.fullAccess ? (["full-access"] as const) : []),
  ];
}

export async function probeScheduledProviders(env: NodeJS.ProcessEnv): Promise<{
  capabilities: ScheduledTaskCapabilities["providers"];
  adapters: Map<string, ScheduledProviderAdapter>;
}> {
  const codexBinary = settingText("agents.codex.binary")?.trim() || "codex";
  let codexAvailable = false;
  let codexReason: string | undefined;
  let autoReviewSupported = false;
  let fullAccessSupported = false;
  let executionPolicies: ScheduledExecutionPolicy[] = ["sandbox"];
  try {
    await execFileAsync(codexBinary, ["--version"], { timeout: 10_000, env });
    await execFileAsync(codexBinary, ["login", "status"], {
      timeout: 10_000,
      env,
    });
    const { stdout } = await execFileAsync(codexBinary, ["exec", "--help"], {
      timeout: 10_000,
      env,
    });
    if (!stdout.includes("--output-schema"))
      throw new Error("structured_result_unsupported");
    const features = detectCodexScheduledFeatures(stdout);
    autoReviewSupported = features.autoReview;
    fullAccessSupported = features.fullAccess;
    executionPolicies = codexScheduledExecutionPolicies(stdout);
    codexAvailable = true;
  } catch {
    codexReason =
      "Codex CLI is unavailable, unauthenticated, or missing structured result support";
  }
  const adapters = new Map<string, ScheduledProviderAdapter>();
  if (codexAvailable)
    adapters.set(
      "codex",
      new CodexScheduledTaskProvider(
        codexBinary,
        autoReviewSupported,
        fullAccessSupported,
      ),
    );
  return {
    adapters,
    capabilities: [
      {
        provider: "codex",
        available: codexAvailable,
        executionPolicies,
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
