import { HttpError } from "../errors.js";

interface ErrorPayload {
  message?: unknown;
  details?: unknown;
}

interface PanelCandidate {
  panelId?: unknown;
  alias?: unknown;
  role?: unknown;
}

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
      const payload = (await response.json()) as ErrorPayload;
      const message = formatErrorPayloadMessage(payload);
      if (message) {
        return new HttpError(response.status, message);
      }
    } catch {
      // Keep the fallback error when the server returns malformed JSON.
    }
  }

  return new HttpError(response.status, fallback);
}

function formatErrorPayloadMessage(payload: ErrorPayload): string | null {
  if (typeof payload.message !== "string" || !payload.message.trim()) {
    return null;
  }
  const panelCandidates = formatPanelCandidates(payload.details);
  if (!panelCandidates) {
    return payload.message;
  }
  return `${payload.message}\n${panelCandidates}`;
}

function formatPanelCandidates(details: unknown): string | null {
  if (!details || typeof details !== "object" || !("panels" in details)) {
    return null;
  }
  const panels = (details as { panels?: unknown }).panels;
  if (!Array.isArray(panels) || panels.length === 0) {
    return null;
  }
  return [
    "Candidate panels:",
    ...panels.map((panel) => `- ${formatPanelCandidate(panel as PanelCandidate)}`),
  ].join("\n");
}

function formatPanelCandidate(panel: PanelCandidate): string {
  const fields = [
    formatCandidateField("panelId", panel.panelId),
    formatCandidateField("alias", panel.alias),
    formatCandidateField("role", panel.role),
  ].filter((field): field is string => Boolean(field));
  return fields.join(", ");
}

function formatCandidateField(name: string, value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? `${name}=${value}`
    : null;
}
