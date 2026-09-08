import type { LoginResponse } from "../protocol";

export const MOBILE_LOGIN_TTL_MS = 180_000;
export const MOBILE_LOGIN_RESULT_TTL_MS = 120_000;
export const MOBILE_LOGIN_MAX_QR_BYTES = 4096;

export interface MobileLoginQrV1 {
  kind: "runweave.mobile-login";
  version: 1;
  baseUrl: string;
  connectionName: string;
  requestId: string;
  qrSecret: string;
  expiresAt: string;
}

export type MobileLoginState =
  | "waiting_scan" | "pending_approval" | "approved" | "issuing"
  | "issued" | "completed" | "cancelled" | "rejected" | "expired"
  | "unconfirmed" | "failed";

export interface MobileLoginStatus {
  requestId: string;
  state: MobileLoginState;
  expiresAt: string;
  claimId?: string;
  deviceName?: string;
}

export interface CreateMobileLoginRequest { baseUrl: string; connectionName: string }
export interface ClaimMobileLoginRequest {
  qrSecret: string;
  claimantToken: string;
  deviceName: string;
  connectionId: string;
}
export interface MobileLoginClaim {
  claimId: string;
  state: MobileLoginState;
  expiresAt: string;
}
export interface MobileLoginDecision {
  claimId: string;
  decision: "approve" | "reject";
}
export type MobileLoginResult = LoginResponse & { refreshToken: string };
export type MobileLoginErrorCode =
  | "invalid_request" | "unauthorized" | "not_found" | "expired"
  | "conflict" | "already_issued" | "rate_limited" | "capacity"
  | "issuance_failed";
export interface MobileLoginFailure { code: MobileLoginErrorCode; message: string }

/** Shareable HTTP base, including a reverse proxy prefix. Never infer a LAN host. */
export function normalizeMobileLoginBaseUrl(raw: string): string {
  if (new TextEncoder().encode(raw).length > 2048 || raw !== raw.trim() || /[\\\s]/u.test(raw)) {
    throw new Error("Invalid mobile connection address");
  }
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
    raw.includes("?") || raw.includes("#") || !host ||
    host === "localhost" || host.endsWith(".localhost") ||
    /^127\./.test(host) || host === "0.0.0.0" ||
    host === "[::]" || host === "[::1]" ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:|0:0\])/i.test(host)) {
    throw new Error("Configure a phone-accessible HTTP(S) connection address");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
