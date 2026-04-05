import crypto from "node:crypto";

export type SignedTokenType =
  | "access"
  | "refresh"
  | "viewer-ws"
  | "terminal-ws"
  | "devtools"
  | "legacy-temp";

export interface TokenResource {
  sessionId?: string;
  terminalSessionId?: string;
  tabId?: string;
}

interface BaseTokenPayload {
  type: SignedTokenType;
  sub: string;
  sid: string;
  exp: number;
  resource?: TokenResource;
}

interface VerifyResult {
  valid: boolean;
  payload?: BaseTokenPayload;
}

function encodePayload(payload: BaseTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encodedPayload: string): BaseTokenPayload | null {
  try {
    const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<BaseTokenPayload>;
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.sid !== "string" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.type !== "string" ||
      !Number.isFinite(parsed.exp)
    ) {
      return null;
    }

    return {
      sub: parsed.sub,
      sid: parsed.sid,
      exp: parsed.exp,
      type: parsed.type as SignedTokenType,
      resource:
        parsed.resource && typeof parsed.resource === "object"
          ? {
              sessionId:
                typeof parsed.resource.sessionId === "string"
                  ? parsed.resource.sessionId
                  : undefined,
              terminalSessionId:
                typeof parsed.resource.terminalSessionId === "string"
                  ? parsed.resource.terminalSessionId
                  : undefined,
              tabId:
                typeof parsed.resource.tabId === "string"
                  ? parsed.resource.tabId
                  : undefined,
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

function signPayload(encodedPayload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

export function issueToken(params: {
  username: string;
  sessionId: string;
  secret: string;
  ttlMs: number;
  tokenType: SignedTokenType;
  resource?: TokenResource;
}): { token: string; expiresIn: number } {
  const nowMs = Date.now();
  const expiresIn = Math.max(1, Math.floor(params.ttlMs / 1000));
  const payload: BaseTokenPayload = {
    sub: params.username,
    sid: params.sessionId,
    exp: Math.floor(nowMs / 1000) + expiresIn,
    type: params.tokenType,
    resource: params.resource,
  };
  const encodedPayload = encodePayload(payload);
  const signature = signPayload(encodedPayload, params.secret);
  return {
    token: `${encodedPayload}.${signature}`,
    expiresIn,
  };
}

export function verifyToken(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false };
  }

  const [encodedPayload, receivedSignature] = parts;
  if (!encodedPayload || !receivedSignature) {
    return { valid: false };
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (receivedBuffer.length !== expectedBuffer.length) {
    return { valid: false };
  }
  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return { valid: false };
  }

  const payload = decodePayload(encodedPayload);
  if (!payload) {
    return { valid: false };
  }

  if (Date.now() >= payload.exp * 1000) {
    return { valid: false };
  }

  return {
    valid: true,
    payload,
  };
}
