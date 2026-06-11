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

function joinUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/+$/, "")}${path}`;
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
  const response = await fetch(joinUrl(apiBase, path), init);
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiError(
      resolveErrorMessage(payload, `Request failed with ${response.status}`),
      response.status,
      payload,
    );
  }
  return (await response.json()) as T;
}

export async function requestBlob(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<Blob> {
  const response = await fetch(joinUrl(apiBase, path), init);
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiError(
      resolveErrorMessage(payload, `Request failed with ${response.status}`),
      response.status,
      payload,
    );
  }
  return response.blob();
}

export async function requestVoid(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(joinUrl(apiBase, path), init);
  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiError(
      resolveErrorMessage(payload, `Request failed with ${response.status}`),
      response.status,
      payload,
    );
  }
}
