import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayStore } from "./store";
export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
}
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function senderFor(store: GatewayStore, token: string) {
  const sender = token ? store.snapshot().senders[hash(token)] : undefined;
  return sender && !sender.revoked ? sender : null;
}
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  status = 400,
  message = "Invalid request",
): asserts condition {
  if (!condition) throw new RequestError(status, message);
}
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}
