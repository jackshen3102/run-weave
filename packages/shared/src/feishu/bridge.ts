/** Fixed Feishu bridge wire contract; no runtime or transport dependencies. */
export const FEISHU_PROTOCOL_VERSION = 1;
export const FEISHU_MAX_TEXT_BYTES = 256 * 1024;
export const FEISHU_MAX_FRAME_BYTES = 512 * 1024;
export const FEISHU_MAX_PENDING = 64;
export const FEISHU_ERRORS = [
  "invalid_request",
  "not_found",
  "not_running",
  "unavailable",
  "busy",
  "expired",
  "input_unknown",
] as const;
export type FeishuBridgeErrorCode = (typeof FEISHU_ERRORS)[number];
export class FeishuBridgeError extends Error {
  constructor(readonly code: FeishuBridgeErrorCode) {
    super(code);
  }
}
export interface FeishuNotifyPayload {
  terminalSessionId: string;
  notificationText: string;
}
export interface FeishuTopicResult {
  rootMessageId: string;
  messageId: string;
  createdTopic: boolean;
}
export type FeishuRequest =
  | { type: "terminal.get"; requestId: string; terminalSessionId: string }
  | {
      type: "terminal.input";
      requestId: string;
      terminalSessionId: string;
      messageId: string;
      text: string;
      expiresAt: number;
    }
  | ({ type: "notify"; requestId: string } & FeishuNotifyPayload);
export type FeishuResultValue =
  | { status: "running" | "exited" }
  | { inputAccepted: boolean; inputEnqueued: boolean }
  | FeishuTopicResult;
export type FeishuResult = { type: "result"; requestId: string } & (
  | { ok: true; value: FeishuResultValue }
  | { ok: false; error: FeishuBridgeErrorCode }
);
export type FeishuFrame =
  | FeishuRequest
  | FeishuResult
  | { type: "hello" | "ready"; protocolVersion: 1 }
  | { type: "status"; report: unknown };
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 256;
export const feishuText = (v: unknown): v is string =>
  typeof v === "string" &&
  !!v.trim() &&
  new TextEncoder().encode(v).length <= FEISHU_MAX_TEXT_BYTES;
export function isFeishuNotifyPayload(v: unknown): v is FeishuNotifyPayload {
  return (
    record(v) &&
    fields(v, ["terminalSessionId", "notificationText"]) &&
    id(v.terminalSessionId) &&
    feishuText(v.notificationText)
  );
}
export function parseFeishuFrame(raw: string): FeishuFrame {
  if (new TextEncoder().encode(raw).length > FEISHU_MAX_FRAME_BYTES)
    throw new FeishuBridgeError("invalid_request");
  const v: unknown = JSON.parse(raw);
  let valid = false;
  if (record(v)) {
    if (v.type === "hello" || v.type === "ready")
      valid = fields(v, ["type", "protocolVersion"]) && v.protocolVersion === 1;
    if (v.type === "status")
      valid = fields(v, ["type", "report"]) && record(v.report);
    if (id(v.requestId)) {
      if (v.type === "terminal.get")
        valid =
          fields(v, ["type", "requestId", "terminalSessionId"]) &&
          id(v.terminalSessionId);
      if (v.type === "terminal.input")
        valid =
          fields(v, [
            "type",
            "requestId",
            "terminalSessionId",
            "messageId",
            "text",
            "expiresAt",
          ]) &&
          id(v.terminalSessionId) &&
          id(v.messageId) &&
          feishuText(v.text) &&
          typeof v.expiresAt === "number" &&
          Number.isSafeInteger(v.expiresAt) &&
          v.expiresAt > 0;
      if (v.type === "notify")
        valid =
          fields(v, [
            "type",
            "requestId",
            "terminalSessionId",
            "notificationText",
          ]) &&
          id(v.terminalSessionId) &&
          feishuText(v.notificationText);
      if (v.type === "result" && v.ok === false)
        valid =
          fields(v, ["type", "requestId", "ok", "error"]) &&
          FEISHU_ERRORS.includes(v.error as FeishuBridgeErrorCode);
      if (v.type === "result" && v.ok === true && record(v.value)) {
        const r = v.value;
        valid =
          fields(v, ["type", "requestId", "ok", "value"]) &&
          ((fields(r, ["status"]) &&
            (r.status === "running" || r.status === "exited")) ||
            (fields(r, ["inputAccepted", "inputEnqueued"]) &&
              typeof r.inputAccepted === "boolean" &&
              typeof r.inputEnqueued === "boolean") ||
            (fields(r, ["rootMessageId", "messageId", "createdTopic"]) &&
              id(r.rootMessageId) &&
              id(r.messageId) &&
              typeof r.createdTopic === "boolean"));
      }
    }
  }
  if (!valid) throw new FeishuBridgeError("invalid_request");
  return v as FeishuFrame;
}
