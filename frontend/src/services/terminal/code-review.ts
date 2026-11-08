import type { CodeReviewDetail, CodeReviewPage, CodeReviewRun, CreateCodeReviewRequest } from "@runweave/shared/terminal/code-review";
import { requestBlob, requestJson } from "../http";
const sessionPath = (id: string) => `/api/terminal/session/${encodeURIComponent(id)}/code-reviews`;
export function createCodeReview(apiBase: string, token: string, id: string, request: CreateCodeReviewRequest): Promise<CodeReviewRun> {
  return requestJson(apiBase, sessionPath(id), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
}
export function listCodeReviews(apiBase: string, token: string, id: string, signal?: AbortSignal, before?: string): Promise<CodeReviewPage> {
  return requestJson(apiBase, sessionPath(id) + (before ? `?before=${encodeURIComponent(before)}` : ""), { headers: { Authorization: `Bearer ${token}` }, signal });
}
export function getCodeReview(apiBase: string, token: string, id: string, signal?: AbortSignal): Promise<CodeReviewDetail> {
  return requestJson(apiBase, `/api/terminal/code-reviews/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, signal });
}
export function getCodeReviewArtifact(apiBase: string, token: string, id: string, artifactId: string): Promise<Blob> {
  return requestBlob(apiBase, `/api/terminal/code-reviews/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`, { headers: { Authorization: `Bearer ${token}` } });
}
