import { BaseWindow, BrowserWindow, ipcMain, type WebContents } from "electron";
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
const MAX_PREVIEW_EDGE = 640;

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
    (candidate) => candidate.windowId === windowId,
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

function attachCaptureSurface(
  windowId: number,
  targetId: string,
  width: number,
  height: number,
): (() => void) | null {
  const owner = BrowserWindow.fromId(windowId);
  const entry = getTerminalBrowserEntryByTargetId(targetId)?.entry;
  if (!owner || !entry) {
    return null;
  }
  if (entry.visible) {
    entry.viewportView.setVisible(false);
    entry.visible = false;
  }
  const previousViewportBounds = entry.viewportView.getBounds();
  const previousContentBounds = entry.view.getBounds();
  const previousBackgroundThrottling =
    entry.view.webContents.getBackgroundThrottling();
  entry.view.webContents.setBackgroundThrottling(false);
  const wasAttached = entry.attached;
  const hasCompositorSize =
    previousContentBounds.width > 0 && previousContentBounds.height > 0;
  if (wasAttached && hasCompositorSize) {
    return () => {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.setBackgroundThrottling(
          previousBackgroundThrottling,
        );
      }
    };
  }
  if (wasAttached) {
    // Target.createTarget can attach a Browser tab before the Browser tool has
    // supplied bounds. Reparent that 0x0 view so bounds are applied after its
    // capture parent exists; resizing it while hidden in-place is ineffective.
    owner.contentView.removeChildView(entry.viewportView);
    entry.attached = false;
  }
  // An unattached or hidden WebContentsView has no compositor surface, so
  // capturePage returns an empty image. Give it a focus-free BaseWindow behind
  // the owning window. BaseWindow adds no extra webContents target of its own,
  // and matching the owner's bounds keeps the host fully covered.
  const ownerBounds = owner.getBounds();
  const host = new BaseWindow({
    show: false,
    ...ownerBounds,
    focusable: false,
    skipTaskbar: true,
  });
  host.contentView.addChildView(entry.viewportView);
  // Bounds must be applied after the nested view is attached. Electron does
  // not propagate a pre-attachment resize to this WebContentsView, leaving its
  // renderer viewport at 0x0 and every capture empty.
  entry.viewportView.setBounds({ x: 0, y: 0, width, height });
  entry.view.setBounds({ x: 0, y: 0, width, height });
  entry.viewportView.setVisible(true);
  const keepBehindOwner = () => {
    if (!host.isDestroyed() && !owner.isDestroyed()) {
      host.setBounds(owner.getBounds());
      owner.moveTop();
    }
  };
  owner.on("move", keepBehindOwner);
  owner.on("resize", keepBehindOwner);
  host.showInactive();
  owner.moveTop();
  return () => {
    if (!owner.isDestroyed()) {
      owner.removeListener("move", keepBehindOwner);
      owner.removeListener("resize", keepBehindOwner);
    }
    if (!host.isDestroyed()) {
      host.contentView.removeChildView(entry.viewportView);
      host.destroy();
    }
    entry.attached = false;
    if (
      wasAttached &&
      !owner.isDestroyed() &&
      !entry.view.webContents.isDestroyed()
    ) {
      owner.contentView.addChildView(entry.viewportView);
      entry.attached = true;
    }
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.setBackgroundThrottling(
        previousBackgroundThrottling,
      );
    }
    entry.viewportView.setVisible(false);
    entry.viewportView.setBounds(previousViewportBounds);
    entry.view.setBounds(previousContentBounds);
  };
}

function startViewerCapture(viewer: ViewerSession): void {
  stopViewerCapture(viewer);
  const targetId = viewer.selectedTargetId;
  if (!viewer.visible || !targetId) {
    return;
  }
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
} {
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
  const actionUntil = Date.now() + ACTION_DURATION_MS;
  const timer = setTimeout(() => {
    activities.delete(targetId);
    notifyWindow(connection.windowId);
  }, ACTION_DURATION_MS);
  activities.set(targetId, {
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
    windowId: win.id,
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
  ipcMain.handle("terminal-browser:automation-get-snapshot", (event) => {
    const win = requireViewerWindow(event.sender);
    return getTerminalBrowserAutomationSnapshot(win.id);
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
