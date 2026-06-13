import type {
  LoginRequest,
  LoginResponse,
  RefreshSessionRequest,
  RefreshSessionResponse,
} from "@runweave/shared";

import { requestJson, requestVoid } from "./http";

const APP_AUTH_HEADERS = {
  "Content-Type": "application/json",
  "X-Auth-Client": "app",
};

export interface AppAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  sessionId: string;
}

function toAppAuthSession(
  response: LoginResponse | RefreshSessionResponse,
): AppAuthSession {
  if (!response.refreshToken) {
    throw new Error("当前后端未启用 App 登录协议，请重启或更新后端后再试");
  }
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresIn: response.expiresIn,
    expiresAt: Date.now() + response.expiresIn * 1000,
    sessionId: response.sessionId,
  };
}

export async function login(
  apiBase: string,
  payload: LoginRequest,
): Promise<AppAuthSession> {
  const response = await requestJson<LoginResponse>(
    apiBase,
    "/api/auth/login",
    {
      method: "POST",
      headers: APP_AUTH_HEADERS,
      body: JSON.stringify(payload),
    },
  );
  return toAppAuthSession(response);
}

export async function refreshSession(
  apiBase: string,
  refreshToken: string,
): Promise<AppAuthSession> {
  const payload: RefreshSessionRequest = { refreshToken };
  const response = await requestJson<RefreshSessionResponse>(
    apiBase,
    "/api/auth/refresh",
    {
      method: "POST",
      headers: APP_AUTH_HEADERS,
      body: JSON.stringify(payload),
    },
  );
  return toAppAuthSession(response);
}

export async function verifySession(
  apiBase: string,
  accessToken: string,
): Promise<boolean> {
  await requestJson<{ valid: true }>(apiBase, "/api/auth/verify", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  return true;
}

export async function logout(
  apiBase: string,
  accessToken: string,
): Promise<void> {
  await requestVoid(apiBase, "/api/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}
