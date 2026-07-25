import type {
  CreateRaceRequest,
  CreateRaceResponse,
  DeleteRaceResponse,
  DeleteRaceWorktreeResponse,
  GetRaceAgentsResponse,
  GetRaceResponse,
} from "@runweave/shared/race";
import { requestJson } from "./http";

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function getRace(
  apiBase: string,
  token: string,
): Promise<GetRaceResponse> {
  return requestJson<GetRaceResponse>(apiBase, "/api/race", {
    headers: authHeaders(token),
  });
}

export async function getRaceAgents(
  apiBase: string,
  token: string,
): Promise<GetRaceAgentsResponse> {
  return requestJson<GetRaceAgentsResponse>(
    apiBase,
    "/api/race/agents",
    { headers: authHeaders(token) },
  );
}

export async function createRace(
  apiBase: string,
  token: string,
  payload: CreateRaceRequest,
): Promise<CreateRaceResponse> {
  return requestJson<CreateRaceResponse>(apiBase, "/api/race", {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function deleteRace(
  apiBase: string,
  token: string,
  raceId: string,
): Promise<DeleteRaceResponse> {
  return requestJson<DeleteRaceResponse>(
    apiBase,
    `/api/race/${encodeURIComponent(raceId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    },
  );
}

export async function deleteRaceWorktree(
  apiBase: string,
  token: string,
  raceId: string,
  workerId: string,
): Promise<DeleteRaceWorktreeResponse> {
  return requestJson<DeleteRaceWorktreeResponse>(
    apiBase,
    `/api/race/${encodeURIComponent(raceId)}/worktree/${encodeURIComponent(workerId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    },
  );
}
