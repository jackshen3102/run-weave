import type { CreateTerminalQuickInputRequest, ListTerminalQuickInputsResponse, TerminalQuickInputItem, TerminalQuickInputListKind, UpdateTerminalQuickInputRequest } from "@runweave/shared/terminal/input";
import { requestJson, requestVoid } from "./http";

export async function listTerminalQuickInputs(
  apiBase: string,
  token: string,
  params: {
    projectId?: string | null;
    q?: string;
    kind?: TerminalQuickInputListKind;
    limit?: number;
  } = {},
): Promise<ListTerminalQuickInputsResponse> {
  const query = new URLSearchParams();
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
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
