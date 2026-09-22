import os from "node:os";
import path from "node:path";
import { KnowledgeInboxService } from "../knowledge-inbox/service";
import { InboxStorage } from "../knowledge-inbox/storage";
import { KnowledgeShareService } from "../knowledge-inbox/shares";
import { EvolutionInboxSource } from "../knowledge-inbox/evolution-source";
import { ExperienceInboxSource } from "../knowledge-inbox/experience-source";
import { resolveExperienceStorage } from "../experience/storage";
import type { EvolutionService } from "../evolution/service";
import type { EvolutionAnalysisStore } from "../evolution/analysis-store";
import type { EvolutionFoundationStore } from "../evolution/foundation-store";
import type { ActivityQueryService } from "../activity/database/service";
import type { ExperienceService } from "../experience/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import type { ResourceScope } from "./resource-scope";

export function createKnowledgeInbox(
  resources: ResourceScope,
  dependencies: {
    evolutionService: EvolutionService;
    evolutionAnalysisStore: EvolutionAnalysisStore | null;
    evolutionFoundationStore: EvolutionFoundationStore | null;
    activityQueryService: ActivityQueryService;
    experienceService: ExperienceService;
    terminalSessionManager: TerminalSessionManager;
  },
): KnowledgeInboxService {
  const storage = resolveExperienceStorage(process.env);
  const home =
    process.env.RUNWEAVE_EXPERIENCE_TEST_MODE === "true"
      ? path.join(storage.home, "knowledge-inbox")
      : path.join(os.homedir(), ".runweave", "knowledge-inbox");
  // Lazy, operation-scoped SQLite connections isolate initialization failures from terminals.
  const inboxStorage = new InboxStorage(path.join(home, storage.namespace));
  const service = new KnowledgeInboxService(
    inboxStorage,
    dependencies.evolutionService.repositories,
    [
      new EvolutionInboxSource(
        dependencies.evolutionAnalysisStore,
        dependencies.evolutionFoundationStore,
        dependencies.activityQueryService,
      ),
      new ExperienceInboxSource(dependencies.experienceService),
    ],
    () => dependencies.terminalSessionManager.listProjects(),
  );
  service.shares = new KnowledgeShareService(inboxStorage, service, dependencies.evolutionService,
    dependencies.experienceService, dependencies.evolutionService.repositories);
  resources.defer("knowledge-inbox", () => service.dispose());
  return service;
}
