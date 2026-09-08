import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MOBILE_LOGIN_TTL_MS, MOBILE_LOGIN_RESULT_TTL_MS, MOBILE_LOGIN_MAX_QR_BYTES,
  normalizeMobileLoginBaseUrl,
  type CreateMobileLoginRequest, type ClaimMobileLoginRequest, type MobileLoginDecision,
  type MobileLoginQrV1, type MobileLoginStatus, type MobileLoginResult,
  type MobileLoginState, type MobileLoginErrorCode,
} from "@runweave/shared/mobile-login";
import type { AuthService } from "./service";

export class MobileLoginError extends Error {
  constructor(public readonly status: number, public readonly code: MobileLoginErrorCode,
    public readonly retryAfter?: number) {
    super(code);
  }
}

interface LoginRequest {
  id: string;
  ownerSessionId: string;
  qrSecretHash?: Buffer;
  state: MobileLoginState;
  expiresAt: number;
  retainUntil?: number;
  claimantTokenHash?: Buffer;
  claimId?: string;
  deviceName?: string;
  connectionId?: string;
  result?: MobileLoginResult;
  issuedSessionId?: string;
  issuance?: Promise<MobileLoginResult>;
}

const unissued = (state: MobileLoginState): boolean =>
  ["waiting_scan", "pending_approval", "approved"].includes(state);
const hash = (secret: string): Buffer => createHash("sha256").update(secret).digest();
const matches = (secret: string, expected?: Buffer): boolean =>
  !!expected && timingSafeEqual(hash(secret), expected);

/** Ephemeral authorization requests. Durable authentication remains owned by AuthService. */
export class MobileLoginService {
  private readonly requests = new Map<string, LoginRequest>();
  private readonly limits = new Map<string, { count: number; until: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly auth: AuthService) {
    this.timer = setInterval(() => this.cleanup(), 5_000);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.requests.clear();
    this.limits.clear();
  }

  rateLimit(key: string, max: number): void {
    this.cleanup();
    let bucket = this.limits.get(key);
    if (!bucket) {
      if (this.limits.size >= 4096) throw new MobileLoginError(429, "rate_limited", 60);
      bucket = { count: 0, until: Date.now() + 60_000 };
      this.limits.set(key, bucket);
    }
    if (++bucket.count > max) {
      throw new MobileLoginError(429, "rate_limited", Math.max(1, Math.ceil((bucket.until - Date.now()) / 1000)));
    }
  }

  create(ownerSessionId: string, input: CreateMobileLoginRequest): MobileLoginQrV1 {
    if (!this.auth.getActiveSession(ownerSessionId)) throw new MobileLoginError(401, "unauthorized");
    this.rateLimit(`owner:${ownerSessionId}`, 10);
    const baseUrl = normalizeMobileLoginBaseUrl(input.baseUrl);
    const previous = [...this.requests.values()].find((r) => r.ownerSessionId === ownerSessionId && unissued(r.state));
    const activeCount = [...this.requests.values()].filter((r) => unissued(r.state) || r.state === "issuing" || r.state === "issued").length;
    if (this.requests.size >= 256) {
      const oldest = [...this.requests.values()]
        .filter((r) => !unissued(r.state) && r.state !== "issuing" && r.state !== "issued")
        .sort((a, b) => (a.retainUntil ?? 0) - (b.retainUntil ?? 0))[0];
      if (oldest) this.requests.delete(oldest.id);
    }
    if (activeCount - (previous ? 1 : 0) >= 64 || this.requests.size >= 256) {
      throw new MobileLoginError(429, "capacity", 60);
    }
    const id = randomUUID();
    const qrSecret = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + MOBILE_LOGIN_TTL_MS;
    const qr: MobileLoginQrV1 = {
      kind: "runweave.mobile-login", version: 1, baseUrl,
      connectionName: input.connectionName, requestId: id, qrSecret,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    if (Buffer.byteLength(JSON.stringify(qr)) > MOBILE_LOGIN_MAX_QR_BYTES) {
      throw new MobileLoginError(400, "invalid_request");
    }
    if (previous) this.finish(previous, "cancelled");
    this.requests.set(id, { id, ownerSessionId, qrSecretHash: hash(qrSecret), state: "waiting_scan", expiresAt });
    return qr;
  }

  status(id: string, ownerSessionId: string): MobileLoginStatus {
    return this.snapshot(this.ownerRequest(id, ownerSessionId));
  }

  claim(id: string, input: ClaimMobileLoginRequest) {
    const request = this.find(id);
    if (!matches(input.qrSecret, request.qrSecretHash)) throw new MobileLoginError(404, "not_found");
    if (request.claimantTokenHash && !matches(input.claimantToken, request.claimantTokenHash)) {
      throw new MobileLoginError(409, "conflict");
    }
    this.requireUnexpired(request);
    if (request.state === "waiting_scan") {
      request.claimantTokenHash = hash(input.claimantToken);
      request.claimId = randomUUID();
      request.deviceName = input.deviceName;
      request.connectionId = input.connectionId;
      request.state = "pending_approval";
    }
    if (!request.claimId) throw new MobileLoginError(409, "conflict");
    return { claimId: request.claimId, state: request.state, expiresAt: new Date(request.expiresAt).toISOString() };
  }

  decision(id: string, ownerSessionId: string, input: MobileLoginDecision): MobileLoginStatus {
    const request = this.ownerRequest(id, ownerSessionId);
    this.requireUnexpired(request);
    if (request.claimId !== input.claimId) throw new MobileLoginError(409, "conflict");
    if (request.state === "pending_approval") {
      if (input.decision === "reject") this.finish(request, "rejected");
      else request.state = "approved";
    } else if (!(input.decision === "approve" && ["approved", "issuing", "issued", "completed"].includes(request.state))) {
      throw new MobileLoginError(409, "conflict");
    }
    return this.snapshot(request);
  }

  async exchange(id: string, claimantToken: string): Promise<MobileLoginResult | MobileLoginStatus> {
    const request = this.claimantRequest(id, claimantToken);
    this.requireUnexpired(request);
    if (request.result) return request.result;
    if (request.issuance) return request.issuance;
    if (request.state !== "approved") return this.snapshot(request);
    // Set the state before the first await. All concurrent exchanges share this promise.
    request.state = "issuing";
    request.issuance = this.issue(request);
    try { return await request.issuance; }
    finally { request.issuance = undefined; }
  }

  complete(id: string, claimantToken: string, sessionId: string): MobileLoginStatus {
    const request = this.claimantRequest(id, claimantToken);
    if (request.issuedSessionId !== sessionId) throw new MobileLoginError(404, "not_found");
    if (request.state === "completed") return this.snapshot(request);
    if (request.state !== "issued") throw new MobileLoginError(410, "expired");
    this.finish(request, "completed");
    request.qrSecretHash = undefined;
    return this.snapshot(request);
  }

  cancel(id: string, proof: { ownerSessionId: string } | { claimantToken: string }): MobileLoginStatus {
    const request = "ownerSessionId" in proof
      ? this.ownerRequest(id, proof.ownerSessionId) : this.claimantRequest(id, proof.claimantToken);
    if (["issuing", "issued", "completed", "unconfirmed"].includes(request.state)) {
      throw new MobileLoginError(409, "already_issued");
    }
    if (unissued(request.state)) this.finish(request, "cancelled");
    return this.snapshot(request);
  }

  private async issue(request: LoginRequest): Promise<MobileLoginResult> {
    try {
      const result = await this.auth.loginFromOwnerSession(request.ownerSessionId, request.connectionId!);
      if (!result) {
        this.finish(request, "expired");
        throw new MobileLoginError(410, "expired");
      }
      request.result = result;
      request.issuedSessionId = result.sessionId;
      request.state = "issued";
      request.retainUntil = Date.now() + MOBILE_LOGIN_RESULT_TTL_MS;
      return result;
    } catch (error) {
      if (request.state === "issuing") this.finish(request, "failed");
      if (error instanceof MobileLoginError) throw error;
      throw new MobileLoginError(503, "issuance_failed");
    }
  }

  private find(id: string): LoginRequest {
    this.cleanup();
    const request = this.requests.get(id);
    // After restart no temporary proof survives; never re-create a request here.
    if (!request) throw new MobileLoginError(410, "expired");
    return request;
  }

  private ownerRequest(id: string, ownerSessionId: string): LoginRequest {
    const request = this.find(id);
    if (request.ownerSessionId !== ownerSessionId) throw new MobileLoginError(404, "not_found");
    return request;
  }

  private claimantRequest(id: string, claimantToken: string): LoginRequest {
    const request = this.find(id);
    if (!matches(claimantToken, request.claimantTokenHash)) throw new MobileLoginError(404, "not_found");
    return request;
  }

  private requireUnexpired(request: LoginRequest): void {
    if (["expired", "unconfirmed"].includes(request.state)) throw new MobileLoginError(410, "expired");
    if (["cancelled", "rejected", "failed"].includes(request.state)) throw new MobileLoginError(409, "conflict");
  }

  private snapshot(request: LoginRequest): MobileLoginStatus {
    return { requestId: request.id, state: request.state, expiresAt: new Date(request.expiresAt).toISOString(),
      ...(request.claimId ? { claimId: request.claimId, deviceName: request.deviceName } : {}) };
  }

  private finish(request: LoginRequest, state: MobileLoginState): void {
    request.state = state;
    request.result = undefined;
    request.retainUntil = Date.now() + MOBILE_LOGIN_RESULT_TTL_MS;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.limits) if (bucket.until <= now) this.limits.delete(key);
    for (const [id, request] of this.requests) {
      if (unissued(request.state) && (request.expiresAt <= now || !this.auth.getActiveSession(request.ownerSessionId))) {
        this.finish(request, "expired");
      } else if (request.retainUntil && request.retainUntil <= now) {
        if (request.state === "issued") this.finish(request, "unconfirmed");
        else this.requests.delete(id);
      }
    }
  }
}
