import type { AgentTeamCatalogModel } from "@runweave/shared/agent-team-model-config";
import {
  isRecord,
  nullablePositiveNumber,
  parseJsonObject,
  runCatalogCommand,
  uniqueStrings,
  type AgentTeamCatalogProbe,
} from "./types";

export async function probeTraexCatalog(
  env: NodeJS.ProcessEnv,
): Promise<AgentTeamCatalogProbe> {
  const version = normalizeVersion(
    await runCatalogCommand("traex", ["--version"], env),
  );
  const publicValue = JSON.parse(
    await runCatalogCommand("traex", ["models", "--json"], env),
  ) as unknown;
  if (!Array.isArray(publicValue)) {
    throw new Error("traex models --json did not return an array");
  }
  const debugPayload = parseJsonObject(
    await runCatalogCommand("traex", ["debug", "models"], env),
    "traex debug models",
  );
  if (!Array.isArray(debugPayload.models)) {
    throw new Error("traex debug models response is missing models");
  }
  return normalizeTraexModels(publicValue, debugPayload.models, version);
}

function normalizeTraexModels(
  publicEntries: unknown[],
  debugEntries: unknown[],
  version: string | null,
): AgentTeamCatalogProbe {
  const warnings: string[] = [];
  const publicCounts = countIds(publicEntries, ["name", "slug"]);
  const debugCounts = countIds(debugEntries, ["slug", "name"]);
  const debugById = new Map<string, Record<string, unknown>>();
  for (const entry of debugEntries) {
    if (!isRecord(entry)) continue;
    const id = firstString(entry, ["slug", "name"]);
    if (id && debugCounts.get(id) === 1) {
      debugById.set(id, entry);
    } else if (id) {
      warnings.push(`traex debug catalog contains duplicate model id ${id}`);
    }
  }

  const models: AgentTeamCatalogModel[] = [];
  for (const entry of publicEntries) {
    if (!isRecord(entry)) {
      warnings.push("traex catalog entry is not an object");
      continue;
    }
    const id = firstString(entry, ["name", "slug"]);
    if (!id || publicCounts.get(id) !== 1) {
      warnings.push(
        id
          ? `traex catalog contains duplicate model id ${id}`
          : "traex catalog entry is missing name/slug",
      );
      continue;
    }
    const debug = debugById.get(id);
    const reasoningEfforts =
      debug && Array.isArray(debug.supported_reasoning_levels)
        ? uniqueStrings(
            debug.supported_reasoning_levels.map((level) =>
              isRecord(level) ? level.effort : null,
            ),
          )
        : [];
    const declaredDefault = debug
      ? stringValue(debug.default_reasoning_level)
      : null;
    models.push({
      id,
      label:
        firstString(entry, ["display_name", "label", "name"]) ??
        (debug
          ? firstString(debug, ["display_name", "label", "slug"])
          : null) ??
        id,
      description:
        stringValue(entry.description) ??
        (debug ? stringValue(debug.description) : null) ??
        "",
      contextWindow:
        nullablePositiveNumber(entry.context_window) ??
        nullablePositiveNumber(
          readPath(entry, ["_meta", "trae", "contextWindow"]),
        ) ??
        (debug ? nullablePositiveNumber(debug.context_window) : null),
      defaultReasoningEffort:
        declaredDefault && reasoningEfforts.includes(declaredDefault)
          ? declaredDefault
          : null,
      reasoningEfforts,
      supportsFast: false,
      supportsMax:
        readPath(entry, ["_meta", "trae", "supportsMaxMode"]) === true &&
        isNonEmptyString(
          debug
            ? readPath(debug, ["business_metadata", "variants", "max_key"])
            : null,
        ),
    });
  }
  if (models.length === 0) {
    throw new Error("traex catalog contains no valid models");
  }
  return { version, models, warnings };
}

function countIds(entries: unknown[], fields: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = firstString(entry, fields);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function firstString(
  value: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const candidate = stringValue(value[field]);
    if (candidate) return candidate;
  }
  return null;
}

function readPath(value: Record<string, unknown>, fields: string[]): unknown {
  let current: unknown = value;
  for (const field of fields) {
    if (!isRecord(current)) return undefined;
    current = current[field];
  }
  return current;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeVersion(raw: string): string | null {
  return raw.trim().split(/\r?\n/, 1)[0]?.trim() || null;
}
