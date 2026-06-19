import { codexAppServerClient } from "../voice/codex-app-server-client";

export type CodexThreadStatusType =
  | "notLoaded"
  | "idle"
  | "systemError"
  | "active";

export interface CodexThreadSnapshot {
  preview: string | null;
  statusType: CodexThreadStatusType | null;
}

interface CodexThreadReadResponse {
  thread?: {
    preview?: unknown;
    status?: {
      type?: unknown;
    };
  };
}

const CODEX_THREAD_STATUS_TYPES = new Set<CodexThreadStatusType>([
  "notLoaded",
  "idle",
  "systemError",
  "active",
]);

export async function readCodexThreadSnapshot(
  threadId: string,
): Promise<CodexThreadSnapshot> {
  const response = (await codexAppServerClient.sendRequest("thread/read", {
    threadId,
    includeTurns: false,
  })) as CodexThreadReadResponse | null;

  return {
    preview: normalizePreview(response?.thread?.preview),
    statusType: normalizeStatusType(response?.thread?.status?.type),
  };
}

function normalizePreview(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStatusType(value: unknown): CodexThreadStatusType | null {
  return typeof value === "string" &&
    CODEX_THREAD_STATUS_TYPES.has(value as CodexThreadStatusType)
    ? (value as CodexThreadStatusType)
    : null;
}
