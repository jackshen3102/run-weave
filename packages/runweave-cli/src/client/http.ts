import { HttpError } from "../errors.js";

export interface RequestOptions extends RequestInit {
  retryOnUnauthorized?: boolean;
}

export async function requestJson<T>(
  baseUrl: string,
  apiPath: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${apiPath}`, init);
  if (!response.ok) {
    throw await buildHttpError(response, apiPath, init);
  }
  return (await response.json()) as T;
}

export async function requestVoid(
  baseUrl: string,
  apiPath: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(`${baseUrl}${apiPath}`, init);
  if (!response.ok) {
    throw await buildHttpError(response, apiPath, init);
  }
}

async function buildHttpError(
  response: Response,
  apiPath: string,
  init?: RequestInit,
): Promise<HttpError> {
  const fallback = `${init?.method ?? "GET"} ${apiPath} failed: ${response.status}`;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim()) {
        return new HttpError(response.status, payload.message);
      }
    } catch {
      // Keep the fallback error when the server returns malformed JSON.
    }
  }

  return new HttpError(response.status, fallback);
}
