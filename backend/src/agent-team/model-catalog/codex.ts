import type { AgentTeamCatalogModel } from "@runweave/shared/agent-team-model-config";
import {
  isRecord,
  nullablePositiveNumber,
  parseJsonObject,
  runCatalogCommand,
  uniqueStrings,
  type AgentTeamCatalogProbe,
} from "./types";

export async function probeCodexCatalog(
  env: NodeJS.ProcessEnv,
): Promise<AgentTeamCatalogProbe> {
  const version = normalizeVersion(
    await runCatalogCommand("codex", ["--version"], env),
  );
  const payload = parseJsonObject(
    await runCatalogCommand("codex", ["debug", "models"], env),
    "codex debug models",
  );
  const entries = Array.isArray(payload.models) ? payload.models : null;
  if (!entries) {
    throw new Error("codex debug models response is missing models");
  }
  return normalizeCodexModels(entries, version);
}

function normalizeCodexModels(
  entries: unknown[],
  version: string | null,
): AgentTeamCatalogProbe {
  const warnings: string[] = [];
  const idCounts = countModelIds(entries, "slug");
  const models: AgentTeamCatalogModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      warnings.push("codex catalog entry is not an object");
      continue;
    }
    const id = stringValue(entry.slug);
    if (!id || idCounts.get(id) !== 1) {
      warnings.push(
        id
          ? `codex catalog contains duplicate model id ${id}`
          : "codex catalog entry is missing slug",
      );
      continue;
    }
    const reasoningEfforts = Array.isArray(entry.supported_reasoning_levels)
      ? uniqueStrings(
          entry.supported_reasoning_levels.map((level) =>
            isRecord(level) ? level.effort : null,
          ),
        )
      : [];
    const declaredDefault = stringValue(entry.default_reasoning_level);
    models.push({
      id,
      label: stringValue(entry.display_name) ?? id,
      description: stringValue(entry.description) ?? "",
      contextWindow: nullablePositiveNumber(entry.context_window),
      defaultReasoningEffort:
        declaredDefault && reasoningEfforts.includes(declaredDefault)
          ? declaredDefault
          : null,
      reasoningEfforts,
      supportsFast: uniqueStrings(entry.additional_speed_tiers).includes(
        "fast",
      ),
      supportsMax: false,
    });
  }
  if (models.length === 0) {
    throw new Error("codex catalog contains no valid models");
  }
  return { version, models, warnings };
}

function countModelIds(entries: unknown[], field: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = stringValue(entry[field]);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeVersion(raw: string): string | null {
  return raw.trim().split(/\r?\n/, 1)[0]?.trim() || null;
}
