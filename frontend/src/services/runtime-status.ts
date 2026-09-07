import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";
import type { RuntimeNodeStatusSnapshot } from "@runweave/shared/runtime-status";

const REQUEST_TIMEOUT_MS = 3_000;

export type RuntimeStatusRequestFailure = "network" | "timeout";

export type BackendHealthResult =
  | { kind: "ok"; payload: BackendHealthPayload }
  | { kind: RuntimeStatusRequestFailure };

export type BackendRuntimeStatusResult =
  | { kind: "ok"; snapshot: RuntimeNodeStatusSnapshot }
  | { kind: "unauthorized" }
  | { kind: "unsupported" }
  | { kind: RuntimeStatusRequestFailure };

function resolveApiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/+$/u, "")}${path}`;
}

async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function classifyRequestError(error: unknown): RuntimeStatusRequestFailure {
  return error instanceof DOMException && error.name === "AbortError"
    ? "timeout"
    : "network";
}

export async function fetchBackendHealth(
  apiBase: string,
): Promise<BackendHealthResult> {
  try {
    const response = await fetchWithTimeout(resolveApiUrl(apiBase, "/health"));
    if (!response.ok) return { kind: "network" };
    return {
      kind: "ok",
      payload: (await response.json()) as BackendHealthPayload,
    };
  } catch (error) {
    return { kind: classifyRequestError(error) };
  }
}

export async function fetchBackendRuntimeStatus(
  apiBase: string,
  token: string,
): Promise<BackendRuntimeStatusResult> {
  try {
    const response = await fetchWithTimeout(
      resolveApiUrl(apiBase, "/api/runtime-status"),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "unsupported" };
    if (!response.ok) return { kind: "network" };
    const snapshot = (await response.json()) as RuntimeNodeStatusSnapshot;
    if (snapshot.protocolVersion !== 1) return { kind: "unsupported" };
    return { kind: "ok", snapshot };
  } catch (error) {
    return { kind: classifyRequestError(error) };
  }
}
