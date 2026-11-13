import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResearchMcpInstallation } from "@runweave/shared/research-mcp";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { resolveConfigurationContext } from "./context";
import { readPrivateFile } from "./private-file";

export function researchMcpHome(context = resolveConfigurationContext()): string {
  return path.join(context.configRoot, "research-mcp");
}

export function readResearchMcpInstallation(context: EnvironmentContext = resolveConfigurationContext()): ResearchMcpInstallation | null {
  const file = path.join(researchMcpHome(context), "installation.json");
  if (!existsSync(file)) return null;
  const value = JSON.parse(readPrivateFile(file)) as ResearchMcpInstallation;
  if (value.version !== 1 || value.instanceId !== context.instanceId ||
      typeof value.enabled !== "boolean" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      ![value.entry, value.node, value.cwd].every((v) => typeof v === "string" && path.isAbsolute(v)) ||
      typeof value.sourceRevision !== "string" || typeof value.releaseId !== "string" ||
      !Number.isFinite(value.installedAt) ||
      (value.tunnel !== null && (!value.tunnel || !/^[a-zA-Z0-9_-]+$/.test(value.tunnel.profile) ||
      ![value.tunnel.executable, value.tunnel.profileDir, value.tunnel.healthFile].every((v) => typeof v === "string" && path.isAbsolute(v))))) {
    throw new Error("Invalid research MCP installation identity");
  }
  return value;
}

export function writeResearchMcpInstallation(value: ResearchMcpInstallation): void {
  const home = researchMcpHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "installation.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
