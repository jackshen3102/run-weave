import type { TerminalBrowserAnnotationDraft, TerminalBrowserAnnotationState } from "@runweave/shared/terminal-browser-annotation";
export type ReviewComment = TerminalBrowserAnnotationDraft;
export interface ReviewContext {
  scope: string;
  projectId: string;
  absolutePath: string;
  terminalSessionId: string | null;
  panelId: string | null;
  available: boolean;
}
export function contextKey(context: ReviewContext): string {
  return JSON.stringify([context.scope, context.projectId, context.absolutePath,
    context.terminalSessionId, context.panelId]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join() === [...names].sort().join();
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function coordinates(value: unknown, names: string[]) {
  return record(value) && keys(value, names) && names.every((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key]) && Math.abs(value[key]) <= 10_000_000 &&
    (!["width", "height"].includes(key) || value[key] >= 0));
}
export function isReviewState(value: unknown): value is TerminalBrowserAnnotationState {
  if (!record(value) || !keys(value, ["active", "selecting", "annotations", "pendingSubmitRequestId"]) ||
    value.active !== true || typeof value.selecting !== "boolean" ||
    !(value.pendingSubmitRequestId === null || bounded(value.pendingSubmitRequestId, 100)) ||
    !Array.isArray(value.annotations) || value.annotations.length > 20) return false;
  const ids = new Set<string>();
  return value.annotations.every((annotation: unknown, index: number) => {
    if (!record(annotation) || !keys(annotation, ["id", "index", "comment", "target"]) ||
      !bounded(annotation.id, 100) || !annotation.id || ids.has(annotation.id) || annotation.index !== index + 1 ||
      !bounded(annotation.comment, 2000) || !annotation.comment.trim() || !record(annotation.target)) return false;
    ids.add(annotation.id);
    const target = annotation.target;
    if (!keys(target, ["elementId", "pageUrl", "frameLabel", "targetText", "targetSelector", "targetPath", "nodePosition", "viewport", "rect", "devicePixelRatio"])) return false;
    for (const [key, limit] of [["elementId", 200], ["pageUrl", 2048], ["frameLabel", 2048], ["targetText", 500], ["targetSelector", 2000], ["targetPath", 500]] as const) {
      if (!bounded(target[key], limit)) return false;
    }
    return coordinates(target.nodePosition, ["x", "y"]) && coordinates(target.viewport, ["width", "height"]) &&
      coordinates(target.rect, ["x", "y", "width", "height"]) && typeof target.devicePixelRatio === "number" &&
      Number.isFinite(target.devicePixelRatio) && target.devicePixelRatio > 0 && target.devicePixelRatio <= 100;
  });
}
