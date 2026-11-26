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
import { probeAgyCatalog } from "./agy";
import { probeCodexCatalog } from "./codex";
import { probeTraexCatalog } from "./traex";
import type { AgentCatalogProbe } from "./types";

const catalogLogger = logger.child({ component: "agent-model-catalog" });
const PROVIDERS: readonly AgentModelProvider[] = ["codex", "traex", "agy"];
const CATALOG_FRESH_TTL_MS = 30_000;

export class AgentModelCatalogService {
  private readonly inFlight = new Map<
    AgentModelProvider,
    Promise<AgentProviderCatalog>
  >();
  private readonly freshUntil = new Map<AgentModelProvider, number>();
  private disposed = false;

  constructor(
    private readonly store: AgentModelCatalogStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.inFlight.values());
  }

  async getCatalogs(): Promise<AgentModelCatalogsResponse> {
    const catalogs = await this.probeProviders(PROVIDERS);
    return {
      catalogs,
    };
  }

  async getProviderCatalogCachedFirst(
    provider: AgentModelProvider,
    options?: { requireFresh?: boolean; forceProbe?: boolean },
  ): Promise<AgentProviderCatalog> {
    if (!options?.forceProbe) {
      const cached = this.store.getCatalog(provider);
      const isFresh = (this.freshUntil.get(provider) ?? 0) > Date.now();
      if (cached && cached.models.length > 0) {
        if (isFresh) {
          return this.catalogFromCache(provider, cached, {
            availability: "available",
            errorCode: null,
          });
        }
        if (!options?.requireFresh) {
          if (!this.disposed) {
            void this.probeProvider(provider);
          }
          return this.catalogFromCache(provider, cached, {
            availability: "available",
            errorCode: null,
          });
        }
      }
    }
    return this.probeProvider(provider);
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

  private probeProvider(
    provider: AgentModelProvider,
  ): Promise<AgentProviderCatalog> {
    const existingFlight = this.inFlight.get(provider);
    if (existingFlight) {
      return existingFlight;
    }
    const flight = this.runProbeProvider(provider).finally(() => {
      if (this.inFlight.get(provider) === flight) {
        this.inFlight.delete(provider);
      }
    });
    this.inFlight.set(provider, flight);
    return flight;
  }

  private async runProbeProvider(
    provider: AgentModelProvider,
  ): Promise<AgentProviderCatalog> {
    try {
      const result =
        provider === "codex"
          ? await probeCodexCatalog(this.env)
          : provider === "agy"
            ? await probeAgyCatalog(this.env)
            : await probeTraexCatalog(this.env);
      const previous = this.disposed ? null : this.store.getCatalog(provider);
      const unchanged =
        previous !== null &&
        previous.version === result.version &&
        JSON.stringify(previous.models) === JSON.stringify(result.models);
      const capturedAt = unchanged
        ? previous.capturedAt
        : new Date().toISOString();
      if (!this.disposed && !unchanged) {
        const persisted: PersistedAgentProviderCatalog = {
          schemaVersion: 1,
          provider,
          command: provider,
          version: result.version,
          capturedAt,
          models: result.models,
        };
        await this.store.saveCatalog(persisted);
      }
      this.freshUntil.set(provider, Date.now() + CATALOG_FRESH_TTL_MS);
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
      const cached = this.disposed ? null : this.store.getCatalog(provider);
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
