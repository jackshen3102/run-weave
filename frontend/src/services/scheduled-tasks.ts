import type {
  CreateScheduledTaskRequest,
  OpenScheduledRunRequest,
  OpenScheduledRunResponse,
  ScheduledRun,
  ScheduledRunOutput,
  ScheduledTask,
  ScheduledTaskCapabilities,
  ScheduledTaskFilter,
  ScheduledTaskPage,
  SchedulePreviewResponse,
  TaskSchedule,
  UpdateScheduledTaskRequest,
} from "@runweave/shared/scheduled-tasks";
import { requestJson } from "./http";

const root = "/api/scheduled-tasks";
const id = encodeURIComponent;

export function scheduledTasksApi(apiBase: string, token: string) {
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
    capabilities: (signal?: AbortSignal) =>
      request<ScheduledTaskCapabilities>("/capabilities", { signal }),
    list: (filter: ScheduledTaskFilter, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
      }
      return request<ScheduledTaskPage<ScheduledTask>>(`?${params}`, {
        signal,
      });
    },
    task: (taskId: string, signal?: AbortSignal) =>
      request<ScheduledTask>(`/${id(taskId)}`, { signal }),
    preview: (schedule: TaskSchedule, signal?: AbortSignal) =>
      request<SchedulePreviewResponse>("/preview", {
        method: "POST",
        body: { schedule },
        signal,
      }),
    create: (body: CreateScheduledTaskRequest, key: string) =>
      request<ScheduledTask>("", { method: "POST", body, key }),
    update: (taskId: string, body: UpdateScheduledTaskRequest) =>
      request<ScheduledTask>(`/${id(taskId)}`, { method: "PATCH", body }),
    remove: (taskId: string, expectedRevision: number) =>
      request<ScheduledTask>(`/${id(taskId)}`, {
        method: "DELETE",
        body: { expectedRevision },
      }),
    start: (taskId: string, key: string) =>
      request<ScheduledRun>(`/${id(taskId)}/runs`, {
        method: "POST",
        body: {},
        key,
      }),
    runs: (taskId: string, cursor?: string, signal?: AbortSignal) =>
      request<ScheduledTaskPage<ScheduledRun>>(
        `/${id(taskId)}/runs${cursor ? `?cursor=${id(cursor)}` : ""}`,
        { signal },
      ),
    run: (runId: string, signal?: AbortSignal) =>
      request<ScheduledRun>(`/runs/${id(runId)}`, { signal }),
    output: (runId: string, cursor?: string, signal?: AbortSignal) =>
      request<ScheduledRunOutput>(
        `/runs/${id(runId)}/output${cursor ? `?cursor=${id(cursor)}` : ""}`,
        { signal },
      ),
    stop: (runId: string) =>
      request<ScheduledRun>(`/runs/${id(runId)}/stop`, { method: "POST" }),
    open: (runId: string, body?: OpenScheduledRunRequest) =>
      request<OpenScheduledRunResponse>(`/runs/${id(runId)}/open-terminal`, {
        method: "POST",
        body,
      }),
  };
}
