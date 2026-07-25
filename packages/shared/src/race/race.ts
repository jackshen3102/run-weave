import type { TerminalAgentPreparationAgent } from "../terminal/agent-preparation";

export type RaceAgent = TerminalAgentPreparationAgent;

export interface RaceWorkerConfig {
  agent: RaceAgent;
  model: string;
}

export type RaceWorkerLaunchStatus = "starting" | "launched" | "failed";

export interface RaceWorkerRecord {
  workerId: string;
  label: string;
  agent: RaceAgent;
  model: string;
  worktreeId: string | null;
  worktreePath: string | null;
  branch: string | null;
  terminalSessionId: string | null;
  launchStatus: RaceWorkerLaunchStatus;
  launchError?: string;
}

export interface RaceRecord {
  raceId: string;
  goal: string;
  plan: string;
  baseRef: string;
  parentProjectId: string;
  createdAt: string;
  workers: RaceWorkerRecord[];
}

export interface RaceAgentCatalogEntry {
  models: string[];
  custom: true;
}

export interface RaceAgentCatalog {
  codex: RaceAgentCatalogEntry;
  traex: RaceAgentCatalogEntry;
}
