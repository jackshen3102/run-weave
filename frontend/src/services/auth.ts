import type {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  RefreshSessionRequest,
  RefreshSessionResponse,
} from "@browser-viewer/shared";
import { requestJson, requestVoid } from "./http";

export async function login(
  apiBase: string,
  payload: LoginRequest,
  options?: {
    clientType?: "web" | "electron";
    connectionId?: string;
  },
): Promise<LoginResponse> {
  const clientType = options?.clientType ?? "web";
  return requestJson<LoginResponse>(apiBase, "/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clientType === "electron"
        ? {
            "x-auth-client": "electron",
            ...(options?.connectionId
              ? { "x-connection-id": options.connectionId }
              : {}),
          }
        : {}),
    },
    body: JSON.stringify(payload),
    ...(clientType === "web" ? { credentials: "include" } : {}),
  });
}

export async function refreshSession(
  apiBase: string,
  options: { clientType: "web" } | { clientType: "electron"; refreshToken: string },
): Promise<RefreshSessionResponse> {
  if (options.clientType === "web") {
    return requestJson<RefreshSessionResponse>(apiBase, "/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
  }

  return requestJson<RefreshSessionResponse>(apiBase, "/api/auth/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-client": "electron",
    },
    body: JSON.stringify({
      refreshToken: options.refreshToken,
    } satisfies RefreshSessionRequest),
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

export async function changePassword(
  apiBase: string,
  token: string,
  payload: ChangePasswordRequest,
): Promise<void> {
  return requestVoid(apiBase, "/api/auth/password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}
