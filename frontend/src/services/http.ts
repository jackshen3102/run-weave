export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

function buildUrl(apiBase: string, path: string): string {
  return `${apiBase}${path}`;
}

async function buildHttpError(
  response: Response,
  path: string,
  init?: RequestInit,
): Promise<HttpError> {
  const fallbackMessage = `${init?.method ?? "GET"} ${path} failed: ${response.status}`;
  const contentType =
    response.headers?.get?.("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as {
        message?: unknown;
        details?: unknown;
      };
      if (typeof payload.message === "string" && payload.message.trim()) {
        return new HttpError(response.status, payload.message, payload.details);
      }
    } catch {
      // Ignore malformed error bodies and keep the fallback message.
    }
  }

  return new HttpError(response.status, fallbackMessage);
}

export async function requestText(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<string> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw await buildHttpError(response, path, init);
  }

  return response.text();
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw await buildHttpError(response, path, init);
  }

  return (await response.json()) as T;
}

export async function requestVoid(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw await buildHttpError(response, path, init);
  }
}

export async function requestBlob(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<Blob> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw await buildHttpError(response, path, init);
  }

  return response.blob();
}
