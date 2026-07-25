import type {
  RaceAgentCatalog,
  RaceRecord,
  RaceWorkerConfig,
} from "./race";

export interface CreateRaceRequest {
  parentProjectId: string;
  goal: string;
  plan: string;
  baseRef: string;
  workers: RaceWorkerConfig[];
}

export type GetRaceResponse = RaceRecord | null;
export type CreateRaceResponse = RaceRecord;
export type GetRaceAgentsResponse = RaceAgentCatalog;

export interface DeleteRaceResponse {
  ok: true;
}

export interface DeleteRaceWorktreeResponse {
  ok: true;
}
