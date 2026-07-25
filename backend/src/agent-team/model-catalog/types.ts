import { execFile } from "node:child_process";
import type { AgentTeamCatalogModel } from "@runweave/shared/agent-team-model-config";

const CATALOG_COMMAND_TIMEOUT_MS = 15_000;
const CATALOG_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

export interface AgentTeamCatalogProbe {
  version: string | null;
  models: AgentTeamCatalogModel[];
  warnings: string[];
}

export function runCatalogCommand(
  command: "codex" | "traex",
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: CATALOG_COMMAND_TIMEOUT_MS,
        maxBuffer: CATALOG_COMMAND_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseJsonObject(
  raw: string,
  label: string,
): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function nullablePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
