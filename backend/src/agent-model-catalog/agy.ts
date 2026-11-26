import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import type { AgentCatalogModel } from "@runweave/shared/agent-model-catalog";
import { runCatalogCommand, type AgentCatalogProbe } from "./types";

const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export async function probeAgyCatalog(
  env: NodeJS.ProcessEnv,
): Promise<AgentCatalogProbe> {
  const { binary } = resolveAgyConfiguration(env);
  const versionOutput = await runCatalogCommand(binary, ["--version"], env);
  const version = normalizeVersion(versionOutput);
  const modelsOutput = await runCatalogCommand(binary, ["models"], env);
  return parseAgyModelsOutput(modelsOutput, version);
}

export function parseAgyModelsOutput(
  output: string,
  version: string | null,
): AgentCatalogProbe {
  const models: AgentCatalogModel[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/^.*\r/, "").trim();
    if (!line || line.startsWith("Fetching available models")) continue;
    const match = /^([a-z0-9][a-z0-9._-]+)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]!.trim();
    if (seen.has(id)) {
      warnings.push(`agy catalog contains duplicate model id ${id}`);
      continue;
    }
    seen.add(id);
    const effortMatch = /-(low|medium|high|xhigh|max)$/i.exec(id);
    const defaultReasoningEffort = effortMatch?.[1]?.toLowerCase() ?? "medium";
    models.push({
      id,
      label: label || id,
      description: "",
      contextWindow: null,
      defaultReasoningEffort,
      reasoningEfforts: [...AGY_EFFORTS],
      supportsFast: false,
      supportsMax: true,
    });
  }

  if (models.length === 0) {
    throw new Error("agy models returned no valid models");
  }
  return { version, models, warnings };
}

function normalizeVersion(raw: string): string | null {
  const match = raw.trim().match(/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}
