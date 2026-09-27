import type {
  CollectEfficiencyRequest,
  CollectEfficiencyResponse,
  CreateEfficiencyFindingEventRequest,
  EfficiencyFindingDetail,
  EfficiencyFindingFilter,
  EfficiencyFindingPage,
  ExecutionEfficiencyStatus,
  PutEfficiencyBindingRequest,
  SubmitEfficiencyResultRequest,
  SubmitEfficiencyResultResponse,
} from "@runweave/shared/execution-efficiency";
import { requestJson } from "./http";

const root = "/api/execution-efficiency";
const id = encodeURIComponent;

export function executionEfficiencyApi(apiBase: string, token: string) {
  function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      key?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    return requestJson(apiBase, `${root}${path}`, {
      method: options.method,
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }
  return {
    status: (projectId: string, signal?: AbortSignal) =>
      request<ExecutionEfficiencyStatus>(
        `/status?projectId=${id(projectId)}`,
        { signal },
      ),
    bind: (body: PutEfficiencyBindingRequest) =>
      request<ExecutionEfficiencyStatus["binding"]>("/binding", {
        method: "PUT",
        body,
      }),
    collect: (body: CollectEfficiencyRequest, key: string) =>
      request<CollectEfficiencyResponse>("/collections", {
        method: "POST",
        body,
        key,
      }),
    submit: (
      analysisId: string,
      body: SubmitEfficiencyResultRequest,
      key: string,
    ) =>
      request<SubmitEfficiencyResultResponse>(
        `/analyses/${id(analysisId)}/result`,
        { method: "POST", body, key },
      ),
    findings: (filter: EfficiencyFindingFilter, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== "") query.set(key, String(value));
      }
      return request<EfficiencyFindingPage>(`/findings?${query}`, { signal });
    },
    finding: (findingId: string, signal?: AbortSignal) =>
      request<EfficiencyFindingDetail>(`/findings/${id(findingId)}`, {
        signal,
      }),
    event: (
      findingId: string,
      body: CreateEfficiencyFindingEventRequest,
      key: string,
    ) =>
      request<EfficiencyFindingDetail>(`/findings/${id(findingId)}/events`, {
        method: "POST",
        body,
        key,
      }),
  };
}
