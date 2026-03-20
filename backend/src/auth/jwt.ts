import crypto from "node:crypto";

interface TokenPayload {
  sub: string;
  exp: number;
}

interface VerifyResult {
  valid: boolean;
  username?: string;
}

function encodePayload(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encodedPayload: string): TokenPayload | null {
  try {
    const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<TokenPayload>;
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp)
    ) {
      return null;
    }
    return { sub: parsed.sub, exp: parsed.exp };
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

export function issueToken(
  username: string,
  secret: string,
  ttlMs: number,
): { token: string; expiresIn: number } {
  const nowMs = Date.now();
  const expiresIn = Math.max(1, Math.floor(ttlMs / 1000));
  const payload: TokenPayload = {
    sub: username,
    exp: Math.floor(nowMs / 1000) + expiresIn,
  };
  const encodedPayload = encodePayload(payload);
  const signature = signPayload(encodedPayload, secret);
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
    username: payload.sub,
  };
}
