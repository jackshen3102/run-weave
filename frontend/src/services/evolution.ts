import type {
  CandidateAsset,
  CreateEvolutionRunRequest,
  CreateEvolutionScheduleRequest,
  EvolutionProviderAvailability,
  EvolutionRun,
  EvolutionRunArtifacts,
  EvolutionRunStage,
  EvolutionSchedule,
  EvolutionScopePolicy,
  Insight,
  RuntimeTraceSummary,
  UpdateEvolutionScheduleRequest,
} from "@runweave/shared/evolution";
import { requestJson, requestVoid } from "./http";

const authHeaders = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
});

const jsonHeaders = (token: string): HeadersInit => ({
  ...authHeaders(token),
  "Content-Type": "application/json",
});

function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function fetchEvolutionRuns(
  apiBase: string,
  token: string,
  query: {
    learningScopeId?: string;
    stage?: EvolutionRunStage;
    limit?: number;
  } = {},
): Promise<{ runs: EvolutionRun[] }> {
  return requestJson(apiBase, `/api/evolution/runs${queryString(query)}`, {
    headers: authHeaders(token),
  });
}

export function fetchEvolutionRun(
  apiBase: string,
  token: string,
  runId: string,
): Promise<EvolutionRun> {
  return requestJson(
    apiBase,
    `/api/evolution/runs/${encodeURIComponent(runId)}`,
    { headers: authHeaders(token) },
  );
}

export function fetchEvolutionRunArtifacts(
  apiBase: string,
  token: string,
  runId: string,
): Promise<EvolutionRunArtifacts> {
  return requestJson(
    apiBase,
    `/api/evolution/runs/${encodeURIComponent(runId)}/artifacts`,
    { headers: authHeaders(token) },
  );
}

export function createEvolutionRun(
  apiBase: string,
  token: string,
  input: CreateEvolutionRunRequest,
): Promise<EvolutionRun> {
  return requestJson(apiBase, "/api/evolution/runs", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  });
}

export function cancelEvolutionRun(
  apiBase: string,
  token: string,
  runId: string,
): Promise<EvolutionRun> {
  return requestJson(
    apiBase,
    `/api/evolution/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
  );
}

export function retryEvolutionRun(
  apiBase: string,
  token: string,
  runId: string,
): Promise<EvolutionRun> {
  return requestJson(
    apiBase,
    `/api/evolution/runs/${encodeURIComponent(runId)}/retry`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
  );
}

export function fetchEvolutionProviders(
  apiBase: string,
  token: string,
): Promise<{
  runtimeAvailable: boolean;
  providers: EvolutionProviderAvailability[];
}> {
  return requestJson(apiBase, "/api/evolution/providers", {
    headers: authHeaders(token),
  });
}

export function fetchEvolutionInsights(
  apiBase: string,
  token: string,
  learningScopeId?: string,
): Promise<{ insights: Insight[] }> {
  return requestJson(
    apiBase,
    `/api/evolution/insights${queryString({ learningScopeId })}`,
    { headers: authHeaders(token) },
  );
}

export function fetchEvolutionSchedules(
  apiBase: string,
  token: string,
  learningScopeId?: string,
): Promise<{ schedules: EvolutionSchedule[] }> {
  return requestJson(
    apiBase,
    `/api/evolution/schedules${queryString({ learningScopeId })}`,
    { headers: authHeaders(token) },
  );
}

export function createEvolutionSchedule(
  apiBase: string,
  token: string,
  input: CreateEvolutionScheduleRequest,
): Promise<EvolutionSchedule> {
  return requestJson(apiBase, "/api/evolution/schedules", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  });
}

export function updateEvolutionSchedule(
  apiBase: string,
  token: string,
  scheduleId: string,
  input: UpdateEvolutionScheduleRequest,
): Promise<EvolutionSchedule> {
  return requestJson(
    apiBase,
    `/api/evolution/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
  );
}

export function deleteEvolutionSchedule(
  apiBase: string,
  token: string,
  scheduleId: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/evolution/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    },
  );
}

export function fetchEvolutionCandidates(
  apiBase: string,
  token: string,
  learningScopeId?: string,
): Promise<{ candidates: CandidateAsset[] }> {
  return requestJson(
    apiBase,
    `/api/evolution/candidates${queryString({ learningScopeId })}`,
    { headers: authHeaders(token) },
  );
}

export function authorizeEvolutionCandidateCanary(
  apiBase: string,
  token: string,
  candidateId: string,
): Promise<CandidateAsset> {
  return requestJson(
    apiBase,
    `/api/evolution/candidates/${encodeURIComponent(candidateId)}/canary`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
  );
}

export function retireEvolutionCandidate(
  apiBase: string,
  token: string,
  candidateId: string,
  reason: string,
): Promise<CandidateAsset> {
  return requestJson(
    apiBase,
    `/api/evolution/candidates/${encodeURIComponent(candidateId)}/retire`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ reason }),
    },
  );
}

export function fetchEvolutionScopePolicy(
  apiBase: string,
  token: string,
  learningScopeId: string,
): Promise<EvolutionScopePolicy> {
  return requestJson(
    apiBase,
    `/api/evolution/scopes/${encodeURIComponent(learningScopeId)}/policy`,
    { headers: authHeaders(token) },
  );
}

export function updateEvolutionScopePolicy(
  apiBase: string,
  token: string,
  learningScopeId: string,
  policy: Omit<
    EvolutionScopePolicy,
    "learningScopeId" | "revision" | "updatedAt" | "updatedBy"
  >,
): Promise<EvolutionScopePolicy> {
  return requestJson(
    apiBase,
    `/api/evolution/scopes/${encodeURIComponent(learningScopeId)}/policy`,
    {
      method: "PUT",
      headers: jsonHeaders(token),
      body: JSON.stringify(policy),
    },
  );
}

export function fetchEvolutionRuntimeTraces(
  apiBase: string,
  token: string,
  query: {
    runId?: string;
    learningScopeId?: string;
    limit?: number;
  },
): Promise<{ traces: RuntimeTraceSummary[] }> {
  return requestJson(
    apiBase,
    `/api/evolution/runtime-traces${queryString(query)}`,
    { headers: authHeaders(token) },
  );
}
