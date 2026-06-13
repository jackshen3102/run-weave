import type { LoginRequest } from "@runweave/shared";
import { calculateExpiresAt, type RunweaveProfile } from "../config/profile-store.js";
import { requestJson } from "./http.js";

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
}

type RefreshResponse = LoginResponse;

export interface AuthClient {
  login(params: {
    baseUrl: string;
    username: string;
    password: string;
  }): Promise<RunweaveProfile>;
  refresh(profile: RunweaveProfile): Promise<RunweaveProfile>;
  verify(profile: RunweaveProfile): Promise<boolean>;
}

export function createAuthClient(): AuthClient {
  return {
    async login(params) {
      const payload = await requestJson<LoginResponse>(
        params.baseUrl,
        "/api/auth/login",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-client": "electron",
          },
          body: JSON.stringify({
            username: params.username,
            password: params.password,
          } satisfies LoginRequest),
        },
      );
      return {
        baseUrl: params.baseUrl,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: calculateExpiresAt(payload.expiresIn),
      };
    },

    async refresh(profile) {
      if (!profile.refreshToken) {
        return profile;
      }
      const payload = await requestJson<RefreshResponse>(
        profile.baseUrl,
        "/api/auth/refresh",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-client": "electron",
          },
          body: JSON.stringify({ refreshToken: profile.refreshToken }),
        },
      );
      return {
        ...profile,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: calculateExpiresAt(payload.expiresIn),
      };
    },

    async verify(profile) {
      await requestJson<{ valid: boolean }>(profile.baseUrl, "/api/auth/verify", {
        headers: {
          Authorization: `Bearer ${profile.accessToken ?? ""}`,
        },
      });
      return true;
    },
  };
}

export function isExpired(profile: RunweaveProfile): boolean {
  if (!profile.expiresAt) {
    return false;
  }
  return Date.parse(profile.expiresAt) <= Date.now() + 30_000;
}
