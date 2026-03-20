import type {
  CreateSessionRequest,
  CreateSessionResponse,
} from "@browser-viewer/shared";
import { requestJson } from "./http";

export async function createSession(
  apiBase: string,
  payload: CreateSessionRequest,
  token: string,
): Promise<CreateSessionResponse> {
  return requestJson<CreateSessionResponse>(apiBase, "/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}
