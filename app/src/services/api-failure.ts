import { ApiError } from "./http";

export type AppApiFailureKind =
  | "auth-expired"
  | "network-unreachable"
  | "timeout"
  | "http-error"
  | "not-found"
  | "unknown";

export interface AppApiFailure {
  kind: AppApiFailureKind;
  status?: number;
  message: string;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)
  );
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return /failed to fetch|networkerror|load failed|network request failed/i.test(
    error.message,
  );
}

export function classifyApiFailure(error: unknown): AppApiFailure {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        kind: "auth-expired",
        status: error.status,
        message: error.message,
      };
    }
    if (error.status === 404) {
      return {
        kind: "not-found",
        status: error.status,
        message: error.message,
      };
    }
    return {
      kind: "http-error",
      status: error.status,
      message: error.message,
    };
  }

  if (isAbortError(error)) {
    return {
      kind: "timeout",
      message: error instanceof Error ? error.message : "Request timed out",
    };
  }

  if (isNetworkError(error)) {
    return {
      kind: "network-unreachable",
      message: error instanceof Error ? error.message : "Network unavailable",
    };
  }

  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
