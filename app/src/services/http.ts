import { recordSupportLog } from "../features/support-logs";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

function isHttpOrigin(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.location.protocol === "http:" ||
    window.location.protocol === "https:"
  );
}

function resolveRequestUrl(apiBase: string, path: string): string {
  const normalizedBase = apiBase.trim().replace(/\/+$/, "");
  if (!normalizedBase) {
    if (isHttpOrigin()) {
      return path;
    }
    throw new ApiConfigurationError(
      "App 后端地址未配置。请使用 pnpm app:ios:local 启动模拟器，或在 app/.env.local 设置 VITE_RUNWEAVE_API_BASE。",
    );
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(normalizedBase);
  } catch {
    throw new ApiConfigurationError(
      "App 后端地址格式不正确，请检查 VITE_RUNWEAVE_API_BASE。",
    );
  }
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
    throw new ApiConfigurationError(
      "App 后端地址必须以 http:// 或 https:// 开头。",
    );
  }

  return `${normalizedBase}${path}`;
}

function sanitizeRequestPath(path: string): string {
  try {
    return new URL(path, "http://runweave.local").pathname;
  } catch {
    return path.split("?")[0] ?? path;
  }
}

function resolveApiBaseHost(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function requestMethod(init?: RequestInit): string {
  return init?.method?.toUpperCase() ?? "GET";
}

function recordRequestCompleted({
  apiBase,
  durationMs,
  init,
  path,
  response,
}: {
  apiBase: string;
  durationMs: number;
  init?: RequestInit;
  path: string;
  response: Response;
}) {
  recordSupportLog("api.request.completed", {
    apiBaseHost: resolveApiBaseHost(apiBase),
    durationMs,
    method: requestMethod(init),
    path: sanitizeRequestPath(path),
    status: response.status,
  });
}

function recordRequestFailed({
  apiBase,
  durationMs,
  error,
  init,
  path,
  status,
}: {
  apiBase: string;
  durationMs: number;
  error: unknown;
  init?: RequestInit;
  path: string;
  status?: number;
}) {
  recordSupportLog(
    "api.request.failed",
    {
      apiBaseHost: resolveApiBaseHost(apiBase),
      durationMs,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      method: requestMethod(init),
      path: sanitizeRequestPath(path),
      status,
    },
    "warn",
  );
}

async function readErrorPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => null);
}

function resolveErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }
  return fallback;
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const response = await fetch(resolveRequestUrl(apiBase, path), init);
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      const error = new ApiError(
        resolveErrorMessage(payload, `Request failed with ${response.status}`),
        response.status,
        payload,
      );
      recordRequestFailed({
        apiBase,
        durationMs,
        error,
        init,
        path,
        status: response.status,
      });
      throw error;
    }
    recordRequestCompleted({ apiBase, durationMs, init, path, response });
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    recordRequestFailed({
      apiBase,
      durationMs: Math.round(performance.now() - startedAt),
      error,
      init,
      path,
    });
    throw error;
  }
}

export async function requestBlob(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<Blob> {
  const startedAt = performance.now();
  try {
    const response = await fetch(resolveRequestUrl(apiBase, path), init);
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      const error = new ApiError(
        resolveErrorMessage(payload, `Request failed with ${response.status}`),
        response.status,
        payload,
      );
      recordRequestFailed({
        apiBase,
        durationMs,
        error,
        init,
        path,
        status: response.status,
      });
      throw error;
    }
    recordRequestCompleted({ apiBase, durationMs, init, path, response });
    return response.blob();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    recordRequestFailed({
      apiBase,
      durationMs: Math.round(performance.now() - startedAt),
      error,
      init,
      path,
    });
    throw error;
  }
}

export async function requestVoid(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const startedAt = performance.now();
  try {
    const response = await fetch(resolveRequestUrl(apiBase, path), init);
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      const error = new ApiError(
        resolveErrorMessage(payload, `Request failed with ${response.status}`),
        response.status,
        payload,
      );
      recordRequestFailed({
        apiBase,
        durationMs,
        error,
        init,
        path,
        status: response.status,
      });
      throw error;
    }
    recordRequestCompleted({ apiBase, durationMs, init, path, response });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    recordRequestFailed({
      apiBase,
      durationMs: Math.round(performance.now() - startedAt),
      error,
      init,
      path,
    });
    throw error;
  }
}
