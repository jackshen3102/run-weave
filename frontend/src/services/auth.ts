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
