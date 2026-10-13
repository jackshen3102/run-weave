import type {
  AgentModelProvider,
  AgentModelCatalogsResponse,
  AgentProviderCatalog,
} from "@runweave/shared/agent-model-catalog";
import { logger } from "../logging/index";
import {
  AgentModelCatalogStore,
  type PersistedAgentProviderCatalog,
} from "./store";
import { probeCodexCatalog } from "./codex";
import { probeTraexCatalog } from "./traex";
import type { AgentCatalogProbe } from "./types";

const catalogLogger = logger.child({ component: "agent-model-catalog" });
const PROVIDERS: readonly AgentModelProvider[] = ["codex", "traex"];

export class AgentModelCatalogService {
  constructor(
    private readonly store: AgentModelCatalogStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async getCatalogs(): Promise<AgentModelCatalogsResponse> {
    const catalogs = await this.probeProviders(PROVIDERS);
    return {
      catalogs,
    };
  }

  private async probeProviders(
    providers: readonly AgentModelProvider[],
  ): Promise<Record<AgentModelProvider, AgentProviderCatalog>> {
    const entries = await Promise.all(
      providers.map(
        async (provider) =>
          [provider, await this.probeProvider(provider)] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<
      AgentModelProvider,
      AgentProviderCatalog
    >;
  }

  private async probeProvider(
    provider: AgentModelProvider,
  ): Promise<AgentProviderCatalog> {
    try {
      const result =
        provider === "codex"
          ? await probeCodexCatalog(this.env)
          : await probeTraexCatalog(this.env);
      const capturedAt = new Date().toISOString();
      const persisted: PersistedAgentProviderCatalog = {
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
      catalogLogger.warn("agent.model-catalog.probe-failed", {
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

  private catalogFromCache(
    provider: AgentModelProvider,
    cached: PersistedAgentProviderCatalog | null,
    state: Pick<AgentProviderCatalog, "availability" | "errorCode">,
  ): AgentProviderCatalog {
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
    provider: AgentModelProvider,
    result: AgentCatalogProbe,
  ): void {
    for (const warning of result.warnings) {
      catalogLogger.warn("agent.model-catalog.entry-dropped", {
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
