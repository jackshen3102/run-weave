import { automationOwner, automationObserver, registerAutomationObserver } from "./observer.js";
import { isTerminalBrowserPresentationRequested } from "../view/presentation.js";
import { attachCaptureSurface } from "./capture-surface.js";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type {
  TerminalBrowserAutomationActionKind,
  TerminalBrowserAutomationActor,
  TerminalBrowserAutomationFrameAcknowledgeRequest,
  TerminalBrowserAutomationSnapshot,
  TerminalBrowserAutomationViewStateRequest,
} from "@runweave/shared/terminal-browser-automation";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { releaseAutomationAttribution } from "./attribution.js";
import { TerminalBrowserAutomationCapture } from "./capture.js";
import type { CdpProxyConnectionState } from "../cdp/proxy/types.js";
import { terminalBrowserEvents } from "../runtime.js";
import {
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByTargetId,
} from "../view/index.js";

const STATE_CHANNEL = "terminal-browser:automation-state-changed";
const FRAME_CHANNEL = "terminal-browser:automation-frame";
const ACTION_DURATION_MS = 4_500;
const MAX_PREVIEW_EDGE = 1280;

interface AutomationConnection {
  connectionId: string;
  actor: TerminalBrowserAutomationActor;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string | null;
  connectedAt: number;
  windowId: number;
  state: CdpProxyConnectionState;
}

interface TargetActivity {
  action: TerminalBrowserAutomationActionKind;
  actionUntil: number;
  pointer: { x: number; y: number } | null;
  timer: NodeJS.Timeout;
  tool?: { name: string; status: "running" | "succeeded" | "unknown" };
}

interface ViewerSession {
  sender: WebContents;
  windowId: number;
  visible: boolean;
  selectedTargetId: string | null;
  maxEdge: number;
  capture: TerminalBrowserAutomationCapture | null;
  captureTargetId: string | null;
  restoreCaptureAttachment: (() => void) | null;
  previewState: "idle" | "connecting" | "live" | "error";
  previewError: string | null;
}

const connections = new Map<string, AutomationConnection>();
const activities = new Map<string, TargetActivity>();
const viewers = new Map<number, ViewerSession>();
const revisions = new Map<number, number>();

function actorKey(actor: TerminalBrowserAutomationActor): string {
  return actor.kind === "terminal"
    ? `terminal:${actor.terminalSessionId}`
    : `unattributed:${actor.connectionId}`;
}

function targetMatchesConnection(
  target: ReturnType<typeof getTerminalBrowserCdpTargets>[number],
  connection: AutomationConnection,
): boolean {
  return (
    target.windowId === connection.windowId &&
    target.profileId === connection.profileId &&
    (!connection.browserGroupId ||
      target.browserGroupId === connection.browserGroupId)
  );
}

function getWindowConnections(windowId: number): AutomationConnection[] {
  return [...connections.values()].filter(
    (connection) => connection.windowId === windowId,
  );
}

export function getTerminalBrowserAutomationSnapshot(
  windowId: number,
): TerminalBrowserAutomationSnapshot {
  const windowConnections = getWindowConnections(windowId);
  const viewer = [...viewers.values()].find(
    (candidate) => candidate.windowId === windowId && candidate.capture !== null,
  );
  const targets = getTerminalBrowserCdpTargets()
    .filter((target) =>
      windowConnections.some((connection) =>
        targetMatchesConnection(target, connection),
      ),
    )
    .map((target) => {
      const entry = getTerminalBrowserEntryByTargetId(target.targetId)?.entry;
      const bounds = entry?.viewportBounds ?? entry?.view.getBounds();
      const deviceViewport = entry?.deviceState.viewport;
      const activity = activities.get(target.targetId);
      const activeActivity =
        activity && activity.actionUntil > Date.now() ? activity : null;
      const actorKeys = [
        ...new Set(
          windowConnections
            .filter((connection) => targetMatchesConnection(target, connection))
            .map((connection) => actorKey(connection.actor)),
        ),
      ];
      const isPreviewTarget = viewer?.captureTargetId === target.targetId;
      return {
        targetId: target.targetId,
        tabId: target.tabId,
        profileId: target.profileId,
        browserGroupId: target.browserGroupId,
        title: target.title,
        url: target.url,
        faviconDataUrl: target.faviconDataUrl,
        loading: target.loading,
        viewportWidth:
          bounds && bounds.width > 0
            ? bounds.width
            : (deviceViewport?.width ?? 1280),
        viewportHeight:
          bounds && bounds.height > 0
            ? bounds.height
            : (deviceViewport?.height ?? 720),
        actorKeys,
        action: activeActivity?.action ?? "idle",
        actionUntil: activeActivity?.actionUntil ?? null,
        tool: activeActivity?.tool,
        pointer: activeActivity?.pointer ?? null,
        previewState: isPreviewTarget
          ? (viewer?.previewState ?? "idle")
          : "idle",
        previewError: isPreviewTarget ? (viewer?.previewError ?? null) : null,
      } as const;
    });
  return {
    revision: revisions.get(windowId) ?? 0,
    connections: windowConnections.map((connection) => ({
      connectionId: connection.connectionId,
      actor: connection.actor,
      profileId: connection.profileId,
      browserGroupId: connection.browserGroupId,
      connectedAt: connection.connectedAt,
      attachedTargetIds: connection.state.sessionManager
        .getAttachedTargetIds()
        .filter((targetId) =>
          targets.some((target) => target.targetId === targetId),
        ),
    })),
    targets,
  };
}

function notifyWindow(windowId: number): void {
  revisions.set(windowId, (revisions.get(windowId) ?? 0) + 1);
  const snapshot = getTerminalBrowserAutomationSnapshot(windowId);
  const observer = automationObserver(windowId);
  if (observer && !observer.isDestroyed()) observer.webContents.send(STATE_CHANNEL, snapshot);
  const win = BrowserWindow.fromId(windowId);
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(STATE_CHANNEL, snapshot);
  }
}

function stopViewerCapture(viewer: ViewerSession): void {
  viewer.capture?.stop();
  viewer.restoreCaptureAttachment?.();
  viewer.capture = null;
  viewer.captureTargetId = null;
  viewer.restoreCaptureAttachment = null;
  viewer.previewState = "idle";
  viewer.previewError = null;
}


function startViewerCapture(viewer: ViewerSession): void {
  stopViewerCapture(viewer);
  const detached = automationObserver(viewer.windowId);
  if (detached && detached.webContents !== viewer.sender && [...viewers.values()].some(other => other.windowId === viewer.windowId && other.sender === detached.webContents && other.visible)) return;
  const targetId = viewer.selectedTargetId;
  if (!viewer.visible || !targetId) {
    return;
  }
  for (const other of viewers.values()) if (other !== viewer && other.windowId === viewer.windowId) stopViewerCapture(other);
  const snapshot = getTerminalBrowserAutomationSnapshot(viewer.windowId);
  if (!snapshot.targets.some((target) => target.targetId === targetId)) {
    return;
  }
  const target = getTerminalBrowserCdpTargets().find(
    (candidate) =>
      candidate.windowId === viewer.windowId && candidate.targetId === targetId,
  );
  const entry = getTerminalBrowserEntryByTargetId(targetId)?.entry;
  if (!target || !entry) {
    return;
  }

  const bounds = entry.viewportBounds ?? entry.view.getBounds();
  const fallbackViewport = entry.deviceState.viewport;
  const viewportWidth =
    bounds.width > 0 ? bounds.width : (fallbackViewport?.width ?? 1280);
  const viewportHeight =
    bounds.height > 0 ? bounds.height : (fallbackViewport?.height ?? 720);
  viewer.restoreCaptureAttachment = attachCaptureSurface(
    viewer.windowId,
    targetId,
    viewportWidth,
    viewportHeight,
  );
  const capture = new TerminalBrowserAutomationCapture({
    onFrame: (frame) => {
      if (
        viewer.capture !== capture ||
        !viewer.visible ||
        viewer.sender.isDestroyed()
      ) {
        capture.acknowledge(frame.sequence);
        return;
      }
      const owner = BrowserWindow.fromId(viewer.windowId);
      if (owner && !entry.attached && isTerminalBrowserPresentationRequested(owner, entry)) {
        // Release the temporary compositor host before presenting the same page
        // in the main Browser; restart capture against its original parent.
        startViewerCapture(viewer);
        return;
      }
      if (viewer.previewState !== "live") {
        viewer.previewState = "live";
        viewer.previewError = null;
        notifyWindow(viewer.windowId);
      }
      viewer.sender.send(FRAME_CHANNEL, {
        targetId: frame.targetId,
        sequence: frame.sequence,
        capturedAt: frame.capturedAt,
        width: frame.width,
        height: frame.height,
        mimeType: frame.mimeType,
        bytes: frame.bytes,
      });
    },
    onError: (_failedTargetId, error) => {
      if (viewer.capture !== capture) {
        return;
      }
      if (
        viewer.previewState !== "error" ||
        viewer.previewError !== error.message
      ) {
        viewer.previewState = "error";
        viewer.previewError = error.message;
        notifyWindow(viewer.windowId);
      }
    },
  });
  viewer.capture = capture;
  viewer.captureTargetId = targetId;
  viewer.previewState = "connecting";
  viewer.previewError = null;
  capture.start({
    source: {
      targetId,
      webContents: target.webContents,
      viewportWidth,
      viewportHeight,
    },
    maxEdge: viewer.maxEdge,
    fps: 5,
  });
}

function reconcileWindowViewers(windowId: number): void {
  const snapshot = getTerminalBrowserAutomationSnapshot(windowId);
  for (const viewer of viewers.values()) {
    if (viewer.windowId !== windowId || !viewer.visible) {
      continue;
    }
    if (
      !viewer.selectedTargetId ||
      !snapshot.targets.some(
        (target) => target.targetId === viewer.selectedTargetId,
      )
    ) {
      viewer.selectedTargetId = null;
      stopViewerCapture(viewer);
    }
  }
}

export function registerTerminalBrowserAutomationConnection(input: {
  connectionId: string;
  actor: TerminalBrowserAutomationActor;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string | null;
  windowId: number;
  state: CdpProxyConnectionState;
}): void {
  connections.set(input.connectionId, {
    ...input,
    connectedAt: Date.now(),
  });
  notifyWindow(input.windowId);
}

export function unregisterTerminalBrowserAutomationConnection(
  connectionId: string,
): void {
  const connection = connections.get(connectionId);
  if (!connection) {
    return;
  }
  connections.delete(connectionId);
  releaseAutomationAttribution(connection.actor);
  reconcileWindowViewers(connection.windowId);
  notifyWindow(connection.windowId);
}

function classifyAction(
  method: string,
  params: Record<string, unknown>,
): {
  action: TerminalBrowserAutomationActionKind | null;
  pointer?: { x: number; y: number };
  tool?: TargetActivity["tool"];
} {
  if (method === "Runweave.callBrowserTool") {
    return { action: "tool", tool: params.tool as TargetActivity["tool"] };
  }
  if (method === "Page.navigate" || method === "Page.setDocumentContent") {
    return { action: "navigate" };
  }
  if (method === "Page.reload") {
    return { action: "reload" };
  }
  if (
    method === "Input.dispatchKeyEvent" ||
    method === "Input.insertText" ||
    method === "Input.imeSetComposition"
  ) {
    return { action: "input" };
  }
  if (method === "Input.dispatchMouseEvent") {
    const pointer =
      typeof params.x === "number" && typeof params.y === "number"
        ? { x: params.x, y: params.y }
        : undefined;
    if (params.type === "mousePressed" || params.type === "mouseReleased") {
      return { action: "click", pointer };
    }
    if (params.type === "mouseWheel") {
      return { action: "scroll", pointer };
    }
    return { action: null, pointer };
  }
  if (method === "Input.dispatchTouchEvent") {
    return { action: "click" };
  }
  return { action: null };
}

export function recordTerminalBrowserAutomationCommand(
  connectionId: string,
  targetId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const connection = connections.get(connectionId);
  if (!connection) {
    return;
  }
  const classified = classifyAction(method, params);
  const existing = activities.get(targetId);
  if (!classified.action) {
    if (classified.pointer && existing) {
      existing.pointer = classified.pointer;
      notifyWindow(connection.windowId);
    }
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
  }
  for (const viewer of viewers.values()) {
    if (viewer.windowId === connection.windowId && viewer.captureTargetId === targetId) {
      viewer.capture?.markActivity();
    }
  }
  const duration = classified.tool?.status === "running" ? 17_000 : ACTION_DURATION_MS;
  const actionUntil = Date.now() + duration;
  const timer = setTimeout(() => {
    activities.delete(targetId);
    notifyWindow(connection.windowId);
  }, duration);
  activities.set(targetId, {
    tool: classified.tool,
    action: classified.action,
    actionUntil,
    pointer: classified.pointer ?? existing?.pointer ?? null,
    timer,
  });
  notifyWindow(connection.windowId);
}

function requireViewerWindow(sender: WebContents): BrowserWindow {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) {
    throw new Error("Automation viewer window is unavailable");
  }
  return win;
}

function getOrCreateViewer(sender: WebContents): ViewerSession {
  const existing = viewers.get(sender.id);
  if (existing) {
    return existing;
  }
  const win = requireViewerWindow(sender);
  const viewer: ViewerSession = {
    sender,
    windowId: automationOwner(win),
    visible: false,
    selectedTargetId: null,
    maxEdge: MAX_PREVIEW_EDGE,
    capture: null,
    captureTargetId: null,
    restoreCaptureAttachment: null,
    previewState: "idle",
    previewError: null,
  };
  viewers.set(sender.id, viewer);
  sender.once("destroyed", () => {
    stopViewerCapture(viewer);
    viewers.delete(sender.id);
    const remaining = [...viewers.values()].find(other => other.windowId === viewer.windowId && other.visible);
    if (remaining) startViewerCapture(remaining);
  });
  win.on("hide", () => {
    viewer.visible = false;
    stopViewerCapture(viewer);
  });
  win.on("minimize", () => {
    viewer.visible = false;
    stopViewerCapture(viewer);
  });
  return viewer;
}

export function registerTerminalBrowserAutomationHandlers(): void {
  registerAutomationObserver();
  ipcMain.handle("terminal-browser:automation-get-snapshot", (event) => {
    const win = requireViewerWindow(event.sender);
    return getTerminalBrowserAutomationSnapshot(automationOwner(win));
  });
  ipcMain.handle(
    "terminal-browser:automation-set-view-state",
    (event, request: TerminalBrowserAutomationViewStateRequest) => {
      if (
        !request ||
        typeof request.visible !== "boolean" ||
        (request.selectedTargetId !== null &&
          typeof request.selectedTargetId !== "string") ||
        !Number.isFinite(request.mainMaxEdge)
      ) {
        throw new Error("Invalid Automation view state");
      }
      const viewer = getOrCreateViewer(event.sender);
      const maxEdge = Math.min(
        MAX_PREVIEW_EDGE,
        Math.max(1, Math.round(request.mainMaxEdge)),
      );
      const unchanged =
        viewer.visible === request.visible &&
        viewer.selectedTargetId === request.selectedTargetId &&
        viewer.maxEdge === maxEdge;
      viewer.visible = request.visible;
      viewer.selectedTargetId = request.selectedTargetId;
      viewer.maxEdge = maxEdge;
      if (!unchanged) {
        startViewerCapture(viewer);
        notifyWindow(viewer.windowId);
      }
    },
  );
  ipcMain.handle(
    "terminal-browser:automation-ack-frame",
    (event, request: TerminalBrowserAutomationFrameAcknowledgeRequest) => {
      if (
        !request ||
        typeof request.targetId !== "string" ||
        !Number.isInteger(request.sequence)
      ) {
        throw new Error("Invalid Automation frame acknowledgement");
      }
      const viewer = getOrCreateViewer(event.sender);
      if (viewer.captureTargetId === request.targetId) {
        viewer.capture?.acknowledge(request.sequence);
      }
    },
  );
}

terminalBrowserEvents.on("workspace-changed", ({ windowId }) => {
  reconcileWindowViewers(windowId);
  notifyWindow(windowId);
});

terminalBrowserEvents.on("tab-updated", ({ windowId }) => {
  notifyWindow(windowId);
});
