import { DefaultEvolutionMemoryProvider } from "../evolution/injection/memory-provider";
import { StructuredEvolutionMemorySelector } from "../evolution/knowledge/retrieval";
import { EvolutionOutcomeObserver } from "../evolution/injection/outcome-observer";
import { EvolutionToolTokenRegistry } from "../evolution/tools/token-registry";
import { EvolutionRepositoryScopes } from "../evolution/repository-scope";
import type { EvolutionRepositoryStore } from "../evolution/repository-store";
import { ACTIVITY_EVENT_NAMES } from "@runweave/shared/activity";
import {
  InMemoryEvolutionActivationStore,
  type EvolutionActivationStore,
} from "../evolution/activation-store";
import type { EvolutionAnalysisStore } from "../evolution/analysis-store";
import type { EvolutionFoundationStore } from "../evolution/foundation-store";
import type { EvolutionContextPackStore } from "../evolution/context-pack-store";
import { SqliteEvolutionActivationStore } from "../evolution/storage/store";
import { EvolutionService } from "../evolution/service";
import { EvolutionProviderAvailabilityService } from "../evolution/providers/availability";
import type { ActivityQueryService } from "../activity/database/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { ResourceScope } from "./resource-scope";
import { logger } from "../logging/index";

export async function createEvolutionStorage(
  evolutionPaths: { learningDatabaseFile: string },
  resources: ResourceScope,
  terminalSessionManager: TerminalSessionManager,
  activityQueryService: ActivityQueryService,
) {
  let evolutionRepositoryStore: EvolutionRepositoryStore | null = null;
  let evolutionActivationStore: EvolutionActivationStore;
  let evolutionAnalysisStore: EvolutionAnalysisStore | null = null;
  let evolutionFoundationStore: EvolutionFoundationStore | null = null;
  let evolutionContextPackStore: EvolutionContextPackStore | null = null;
  try {
    const persistentEvolutionStore =
      await SqliteEvolutionActivationStore.create({
        databasePath: evolutionPaths.learningDatabaseFile,
        env: process.env,
      });
    evolutionRepositoryStore = persistentEvolutionStore;
    evolutionActivationStore = persistentEvolutionStore;
    evolutionAnalysisStore = persistentEvolutionStore;
    evolutionFoundationStore = persistentEvolutionStore;
    evolutionContextPackStore = persistentEvolutionStore;
  } catch (error) {
    logger.warn("evolution.initialize.failed", {
      component: "evolution",
      message:
        "Persistent Evolution activation is unavailable; Backend continues with disabled in-memory policy",
      error,
    });
    evolutionActivationStore = new InMemoryEvolutionActivationStore();
  }
  resources.defer("evolution-store", () => evolutionActivationStore.close());
  const evolutionProviderAvailability =
    new EvolutionProviderAvailabilityService();
  const evolutionService = new EvolutionService(
    evolutionFoundationStore,
    undefined,
    evolutionProviderAvailability,
    evolutionAnalysisStore,
    evolutionContextPackStore,
    evolutionActivationStore,
    evolutionRepositoryStore
      ? new EvolutionRepositoryScopes(
          evolutionRepositoryStore,
          () => terminalSessionManager.listProjects(),
          (id) =>
            terminalSessionManager.getProjectContext(id)?.path ??
            terminalSessionManager.getProject(id)?.path ??
            null,
        )
      : null,
    async (repositoryId) =>
      (
        await activityQueryService.evolutionSnapshot({
          learningScopeId: repositoryId,
          afterWatermark: 0,
          eventNames: [...ACTIVITY_EVENT_NAMES],
          limit: 1,
        })
      ).snapshotBoundary,
  );
  const evolutionToolTokenRegistry = new EvolutionToolTokenRegistry();
  resources.defer("evolution-tool-tokens", () =>
    evolutionToolTokenRegistry.clear(),
  );
  const evolutionMemoryProvider = new DefaultEvolutionMemoryProvider(
    evolutionActivationStore,
    new StructuredEvolutionMemorySelector(),
  );
  const evolutionOutcomeObserver = new EvolutionOutcomeObserver(
    evolutionActivationStore,
  );
  return {
    evolutionActivationStore,
    evolutionAnalysisStore,
    evolutionFoundationStore,
    evolutionContextPackStore,
    evolutionProviderAvailability,
    evolutionService,
    evolutionToolTokenRegistry,
    evolutionMemoryProvider,
    evolutionOutcomeObserver,
  };
}
