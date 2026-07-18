import type { WebContents } from "electron";
import type {
  TerminalBrowserAnnotationDraft,
  TerminalBrowserAnnotationRect,
  TerminalBrowserAnnotationState,
  TerminalBrowserAnnotationSubmission,
  TerminalBrowserAnnotationTarget,
} from "@runweave/shared/terminal-browser-annotation";
import {
  buildAnnotationRuntimeScript,
  TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL,
} from "./terminal-browser-annotation-runtime.js";

interface AnnotationSession {
  webContents: WebContents;
}

const sessions = new Map<string, AnnotationSession>();

function buildRuntimeCallScript(method: string, argument?: unknown): string {
  const globalName = JSON.stringify(TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL);
  const methodName = JSON.stringify(method);
  const args = argument === undefined ? "" : JSON.stringify(argument);
  return `(() => {
    const runtime = window[${globalName}];
    if (!runtime?.active || typeof runtime[${methodName}] !== "function") {
      return { active: false, selecting: false, annotations: [] };
    }
    return runtime[${methodName}](${args});
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRect(value: unknown): TerminalBrowserAnnotationRect {
  const record = isRecord(value) ? value : {};
  return {
    x: normalizeNumber(record.x),
    y: normalizeNumber(record.y),
    width: normalizeNumber(record.width),
    height: normalizeNumber(record.height),
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeTarget(value: unknown): TerminalBrowserAnnotationTarget {
  const record = isRecord(value) ? value : {};
  const viewport = isRecord(record.viewport) ? record.viewport : {};
  const nodePosition = isRecord(record.nodePosition) ? record.nodePosition : {};
  return {
    pageUrl: normalizeString(record.pageUrl),
    frameLabel: normalizeString(record.frameLabel) || "top document",
    targetText: normalizeString(record.targetText),
    targetSelector: normalizeString(record.targetSelector),
    targetPath: normalizeString(record.targetPath),
    nodePosition: {
      x: normalizeNumber(nodePosition.x),
      y: normalizeNumber(nodePosition.y),
    },
    viewport: {
      width: normalizeNumber(viewport.width),
      height: normalizeNumber(viewport.height),
    },
    rect: normalizeRect(record.rect),
    devicePixelRatio: normalizeNumber(record.devicePixelRatio) || 1,
  };
}

function normalizeDraft(value: unknown): TerminalBrowserAnnotationDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeString(value.id);
  const comment = normalizeString(value.comment);
  if (!id || !comment) {
    return null;
  }
  return {
    id,
    index: Math.max(1, Math.round(normalizeNumber(value.index))),
    comment,
    target: normalizeTarget(value.target),
  };
}

function normalizeState(value: unknown): TerminalBrowserAnnotationState {
  const record = isRecord(value) ? value : {};
  const annotations = Array.isArray(record.annotations)
    ? record.annotations
        .map(normalizeDraft)
        .filter(
          (draft): draft is TerminalBrowserAnnotationDraft => draft !== null,
        )
    : [];
  return {
    active: record.active === true,
    selecting: record.selecting === true,
    annotations,
    pendingSubmitRequestId:
      typeof record.pendingSubmitRequestId === "string"
        ? record.pendingSubmitRequestId
        : null,
  };
}

async function callAnnotationRuntime(
  key: string,
  method: string,
  argument?: unknown,
): Promise<TerminalBrowserAnnotationState> {
  const session = sessions.get(key);
  if (!session || session.webContents.isDestroyed()) {
    sessions.delete(key);
    return { active: false, selecting: false, annotations: [] };
  }
  try {
    const result = await session.webContents.executeJavaScript(
      buildRuntimeCallScript(method, argument),
      true,
    );
    const state = normalizeState(result);
    if (!state.active) {
      sessions.delete(key);
    }
    return state;
  } catch {
    sessions.delete(key);
    return { active: false, selecting: false, annotations: [] };
  }
}

export async function startTerminalBrowserAnnotation(
  key: string,
  webContents: WebContents,
): Promise<TerminalBrowserAnnotationState> {
  sessions.set(key, { webContents });
  const result = await webContents.executeJavaScript(
    buildAnnotationRuntimeScript(),
    true,
  );
  return normalizeState(result);
}

export async function listTerminalBrowserAnnotations(
  key: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "list");
}

export async function deleteTerminalBrowserAnnotation(
  key: string,
  annotationId: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "remove", annotationId);
}

export async function focusTerminalBrowserAnnotation(
  key: string,
  annotationId: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "focus", annotationId);
}

export async function setTerminalBrowserAnnotationSelecting(
  key: string,
  selecting: boolean,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "setSelecting", selecting);
}

export async function setTerminalBrowserAnnotationSubmitting(
  key: string,
  submitting: boolean,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "setSubmitting", submitting);
}

export async function stopTerminalBrowserAnnotation(
  key: string,
): Promise<TerminalBrowserAnnotationState> {
  return await callAnnotationRuntime(key, "stop");
}

export async function submitTerminalBrowserAnnotations(
  key: string,
): Promise<TerminalBrowserAnnotationSubmission> {
  const session = sessions.get(key);
  const state = await callAnnotationRuntime(key, "submit");
  if (
    !session ||
    session.webContents.isDestroyed() ||
    state.annotations.length === 0
  ) {
    await callAnnotationRuntime(key, "setSubmitting", false);
    return { annotations: state.annotations, screenshot: null };
  }

  try {
    const image = await session.webContents.capturePage();
    const screenshot = {
      mimeType: "image/png" as const,
      dataBase64: image.toPNG().toString("base64"),
    };
    return { annotations: state.annotations, screenshot };
  } catch (error) {
    await callAnnotationRuntime(key, "setSubmitting", false);
    throw error;
  }
}

export function clearTerminalBrowserAnnotation(key: string): void {
  const session = sessions.get(key);
  sessions.delete(key);
  if (!session || session.webContents.isDestroyed()) {
    return;
  }
  void session.webContents
    .executeJavaScript(buildRuntimeCallScript("stop"), true)
    .catch(() => {
      // The page may already be navigating or destroyed; navigation also clears DOM.
    });
}

export function clearTerminalBrowserAnnotationsForWindow(
  windowId: number,
): void {
  const prefix = `${windowId}:`;
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix)) {
      clearTerminalBrowserAnnotation(key);
    }
  }
}
