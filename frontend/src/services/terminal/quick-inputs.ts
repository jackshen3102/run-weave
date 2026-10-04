import type {
  CreateTerminalQuickInputRequest,
  ListTerminalQuickInputsResponse,
  TerminalQuickInputItem,
  TerminalQuickInputListKind,
  UpdateTerminalQuickInputRequest,
} from "@runweave/shared/terminal/input";
import type {
  ScheduledRun,
  StartQuickInputRunRequest,
} from "@runweave/shared/scheduled-tasks";
import { requestJson, requestVoid } from "../http";

export async function listTerminalQuickInputs(
  apiBase: string,
  token: string,
  params: {
    projectId?: string | null;
    q?: string;
    kind?: TerminalQuickInputListKind;
    limit?: number;
    scope?: "global";
    order?: "manual";
    cursor?: string;
  } = {},
  signal?: AbortSignal,
): Promise<ListTerminalQuickInputsResponse> {
  const query = new URLSearchParams();
  if (params.scope) query.set("scope", params.scope);
  if (params.order) query.set("order", params.order);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.projectId) {
    query.set("projectId", params.projectId);
  }
  if (params.q?.trim()) {
    query.set("q", params.q.trim());
  }
  if (params.kind) {
    query.set("kind", params.kind);
  }
  if (params.limit !== undefined) {
    query.set("limit", String(params.limit));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson<ListTerminalQuickInputsResponse>(
    apiBase,
    `/api/terminal/quick-inputs${suffix}`,
    {
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function moveTerminalQuickInput(
  apiBase: string,
  token: string,
  id: string,
  beforeId: string | null,
  expectedOrderVersion: string,
): Promise<{ orderVersion: string }> {
  return requestJson(
    apiBase,
    `/api/terminal/quick-inputs/${encodeURIComponent(id)}/move`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ beforeId, expectedOrderVersion }),
    },
  );
}

export async function createTerminalQuickInput(
  apiBase: string,
  token: string,
  payload: CreateTerminalQuickInputRequest,
): Promise<TerminalQuickInputItem> {
  return requestJson<TerminalQuickInputItem>(
    apiBase,
    "/api/terminal/quick-inputs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function updateTerminalQuickInput(
  apiBase: string,
  token: string,
  id: string,
  payload: UpdateTerminalQuickInputRequest,
): Promise<TerminalQuickInputItem> {
  return requestJson<TerminalQuickInputItem>(
    apiBase,
    `/api/terminal/quick-inputs/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteTerminalQuickInput(
  apiBase: string,
  token: string,
  id: string,
): Promise<void> {
  return requestVoid(
    apiBase,
    `/api/terminal/quick-inputs/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function markTerminalQuickInputUsed(
  apiBase: string,
  token: string,
  id: string,
): Promise<TerminalQuickInputItem> {
  return requestJson<TerminalQuickInputItem>(
    apiBase,
    `/api/terminal/quick-inputs/${encodeURIComponent(id)}/used`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
}

export async function startTerminalQuickInputRun(
  apiBase: string,
  token: string,
  id: string,
  payload: StartQuickInputRunRequest,
  idempotencyKey: string,
): Promise<ScheduledRun> {
  return requestJson<ScheduledRun>(
    apiBase,
    `/api/terminal/quick-inputs/${encodeURIComponent(id)}/run`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    },
  );
}
