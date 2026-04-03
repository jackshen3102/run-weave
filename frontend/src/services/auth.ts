import type { LoginRequest, LoginResponse } from "@browser-viewer/shared";
import { requestJson } from "./http";

export async function login(
  apiBase: string,
  payload: LoginRequest,
): Promise<LoginResponse> {
  return requestJson<LoginResponse>(apiBase, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function verifyAuthToken(
  apiBase: string,
  token: string,
): Promise<{ valid: true }> {
  return requestJson<{ valid: true }>(apiBase, "/api/auth/verify", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
