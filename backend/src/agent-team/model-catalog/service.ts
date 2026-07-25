import type {
  AgentTeamGlobalModelConfig,
  AgentTeamModelProvider,
  AgentTeamModelSettingsResponse,
  AgentTeamProviderCatalog,
  AgentTeamRoleRuntimeSnapshot,
  SaveAgentTeamModelConfigRequest,
} from "@runweave/shared/agent-team-model-config";
import { logger } from "../../logging";
import { AgentTeamError } from "../errors";
import {
  AgentTeamModelConfigStore,
  type PersistedAgentTeamProviderCatalog,
} from "../model-config-store";
import {
  createAgentTeamRoleRuntimeSnapshot,
  isAgentTeamRoleModelConfigMap,
} from "../model-runtime";
import { probeCodexCatalog } from "./codex";
import { probeTraexCatalog } from "./traex";
import type { AgentTeamCatalogProbe } from "./types";

const catalogLogger = logger.child({ component: "agent-team-model-catalog" });
const PROVIDERS: readonly AgentTeamModelProvider[] = ["codex", "traex"];

export class AgentTeamModelSettingsService {
  constructor(
    private readonly store: AgentTeamModelConfigStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async getSettings(): Promise<AgentTeamModelSettingsResponse> {
    const catalogs = await this.probeProviders(PROVIDERS);
    return {
      config: this.store.getConfig(),
      catalogs,
    };
  }

  async saveSettings(
    request: SaveAgentTeamModelConfigRequest,
  ): Promise<AgentTeamModelSettingsResponse> {
    if (!isAgentTeamRoleModelConfigMap(request.roles)) {
      throw new AgentTeamError(400, "Agent Team 模型配置结构无效");
    }
    const catalogs = await this.probeProviders(PROVIDERS);
    createAgentTeamRoleRuntimeSnapshot(
      {
        schemaVersion: 1,
        roles: request.roles,
        updatedAt: new Date().toISOString(),
      },
      catalogs,
    );
    const config: AgentTeamGlobalModelConfig = {
      schemaVersion: 1,
      roles: structuredClone(request.roles),
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveConfig(config);
    return { config, catalogs };
  }

  async resolveGlobalRuntimeSnapshot(): Promise<AgentTeamRoleRuntimeSnapshot> {
    const config = this.store.getConfig();
    if (!config) {
      throw new AgentTeamError(409, "请先配置 Agent Team 四个角色的模型", {
        code: "config_required",
      });
    }
    const referencedProviders = Array.from(
      new Set(Object.values(config.roles).map((role) => role.provider)),
    );
    const catalogs = await this.probeProviders(referencedProviders);
    return createAgentTeamRoleRuntimeSnapshot(config, catalogs);
  }

  private async probeProviders(
    providers: readonly AgentTeamModelProvider[],
  ): Promise<Record<AgentTeamModelProvider, AgentTeamProviderCatalog>> {
    const requested = new Set(providers);
    const entries = await Promise.all(
      PROVIDERS.map(
        async (provider) =>
          [
            provider,
            requested.has(provider)
              ? await this.probeProvider(provider)
              : this.unprobedCatalog(provider),
          ] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<
      AgentTeamModelProvider,
      AgentTeamProviderCatalog
    >;
  }

  private async probeProvider(
    provider: AgentTeamModelProvider,
  ): Promise<AgentTeamProviderCatalog> {
    try {
      const result =
        provider === "codex"
          ? await probeCodexCatalog(this.env)
          : await probeTraexCatalog(this.env);
      const capturedAt = new Date().toISOString();
      const persisted: PersistedAgentTeamProviderCatalog = {
        schemaVersion: 1,
        provider,
        command: provider,
        version: result.version,
        capturedAt,
        models: result.models,
      };
      await this.store.saveCatalog(persisted);
      this.logWarnings(provider, result);
      return {
        provider,
        command: provider,
        availability: "available",
        source: "fresh",
        version: result.version,
        capturedAt,
        models: structuredClone(result.models),
        errorCode: null,
      };
    } catch (error) {
      const cached = this.store.getCatalog(provider);
      const cliMissing = isCommandMissing(error);
      catalogLogger.warn("agent-team.model-catalog.probe-failed", {
        message: `${provider} model catalog probe failed`,
        provider,
        errorCode: cliMissing ? "cli_missing" : "catalog_unavailable",
        failure: summarizeCatalogFailure(error),
      });
      if (cliMissing) {
        return this.catalogFromCache(provider, cached, {
          availability: "unavailable",
          errorCode: "cli_missing",
        });
      }
      if (cached) {
        return this.catalogFromCache(provider, cached, {
          availability: "available",
          errorCode: "catalog_unavailable",
        });
      }
      return {
        provider,
        command: provider,
        availability: "unavailable",
        source: "none",
        version: null,
        capturedAt: null,
        models: [],
        errorCode: "catalog_unavailable",
      };
    }
  }

  private unprobedCatalog(
    provider: AgentTeamModelProvider,
  ): AgentTeamProviderCatalog {
    return this.catalogFromCache(provider, this.store.getCatalog(provider), {
      availability: "unavailable",
      errorCode: null,
    });
  }

  private catalogFromCache(
    provider: AgentTeamModelProvider,
    cached: PersistedAgentTeamProviderCatalog | null,
    state: Pick<AgentTeamProviderCatalog, "availability" | "errorCode">,
  ): AgentTeamProviderCatalog {
    return {
      provider,
      command: provider,
      availability: state.availability,
      source: cached ? "cache" : "none",
      version: cached?.version ?? null,
      capturedAt: cached?.capturedAt ?? null,
      models: structuredClone(cached?.models ?? []),
      errorCode: state.errorCode,
    };
  }

  private logWarnings(
    provider: AgentTeamModelProvider,
    result: AgentTeamCatalogProbe,
  ): void {
    for (const warning of result.warnings) {
      catalogLogger.warn("agent-team.model-catalog.entry-dropped", {
        message: warning,
        provider,
      });
    }
  }
}

function isCommandMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function summarizeCatalogFailure(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) {
    return { kind: typeof error };
  }
  return {
    kind:
      "name" in error && typeof error.name === "string"
        ? error.name
        : "external_command_error",
    code:
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
        ? error.code
        : null,
    signal:
      "signal" in error && typeof error.signal === "string"
        ? error.signal
        : null,
    killed: "killed" in error && error.killed === true,
  };
}
