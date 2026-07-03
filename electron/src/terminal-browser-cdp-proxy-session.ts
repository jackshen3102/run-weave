import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  getTerminalBrowserEntryByTargetId,
  markTerminalBrowserMcpActivity,
  setTerminalBrowserCdpProxyAttached,
} from "./terminal-browser-view.js";
import { shouldMarkTerminalBrowserMcpActivity } from "./terminal-browser-cdp-activity.js";

export interface CdpProxySession {
  proxySessionId: string;
  targetId: string;
  electronSessionId: string | null;
}

interface AttachedTarget {
  targetId: string;
  webContents: WebContents;
  proxySessionId: string;
  electronSessionId: string | null;
  defaultContextId: number | null;
  defaultContextEmitted: boolean;
  rootFrameId: string | null;
  detached: boolean;
  onDebuggerMessage: (
    event: Electron.Event,
    method: string,
    params: object,
    sessionId?: string,
  ) => void;
  onDebuggerDetach: (event: Electron.Event, reason: string) => void;
}

type MessageRelay = (data: object) => void;

let nextSyntheticContextId = 1_000_000_000;

interface SharedDebuggerAttachment {
  webContents: WebContents;
  refCount: number;
}

const sharedDebuggerAttachments = new Map<string, SharedDebuggerAttachment>();

function attachSharedDebugger(targetId: string, webContents: WebContents): void {
  const existing = sharedDebuggerAttachments.get(targetId);
  if (existing) {
    existing.refCount += 1;
    setTerminalBrowserCdpProxyAttached(targetId, true);
    return;
  }

  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (found?.entry.devtoolsOpen) {
    throw new Error("DevTools is already open for this browser tab");
  }

  if (!found?.entry.deviceDebuggerAttached) {
    try {
      webContents.debugger.attach("1.3");
    } catch {
      // Debugger may still be attached from a previous connection that did not
      // cleanly close (e.g. process killed without WebSocket close frame).
      // Detach first, then retry once — but only if DevTools is not open,
      // since we must not forcibly steal the debugger from an active DevTools.
      const entry = getTerminalBrowserEntryByTargetId(targetId);
      if (entry?.entry.devtoolsOpen || webContents.isDevToolsOpened()) {
        throw new Error("DevTools is already open for this browser tab");
      }
      if (!entry?.entry.deviceDebuggerAttached) {
        try {
          webContents.debugger.detach();
          webContents.debugger.attach("1.3");
        } catch (retryError) {
          throw new Error(
            `Failed to attach debugger: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
        }
      }
    }
  }

  sharedDebuggerAttachments.set(targetId, { webContents, refCount: 1 });
  setTerminalBrowserCdpProxyAttached(targetId, true);
}

function releaseSharedDebugger(targetId: string): void {
  const shared = sharedDebuggerAttachments.get(targetId);
  if (!shared) {
    setTerminalBrowserCdpProxyAttached(targetId, false);
    return;
  }

  shared.refCount -= 1;
  if (shared.refCount > 0) {
    return;
  }

  sharedDebuggerAttachments.delete(targetId);
  const found = getTerminalBrowserEntryByTargetId(targetId);
  if (!found?.entry.deviceDebuggerAttached) {
    try {
      shared.webContents.debugger.detach();
    } catch {
      // Already detached.
    }
  }
  setTerminalBrowserCdpProxyAttached(targetId, false);
}

function clearSharedDebugger(targetId: string): void {
  sharedDebuggerAttachments.delete(targetId);
  setTerminalBrowserCdpProxyAttached(targetId, false);
}

export class CdpSessionManager {
  private readonly targets = new Map<string, AttachedTarget>();
  private readonly proxySessionToTarget = new Map<string, string>();
  private readonly electronSessionToProxy = new Map<string, string>();
  private messageRelay: MessageRelay | null = null;

  setMessageRelay(relay: MessageRelay): void {
    this.messageRelay = relay;
  }

  attachDebugger(
    targetId: string,
    webContents: WebContents,
  ): { proxySessionId: string } {
    const existing = this.targets.get(targetId);
    if (existing && !existing.detached) {
      return { proxySessionId: existing.proxySessionId };
    }

    attachSharedDebugger(targetId, webContents);

    const proxySessionId = randomUUID();
    const onDebuggerMessage = (
      _event: Electron.Event,
      method: string,
      params: object,
      sessionId?: string,
    ): void => {
      this.handleDebuggerMessage(targetId, method, params, sessionId);
    };
    const onDebuggerDetach = (
      _event: Electron.Event,
      reason: string,
    ): void => {
      console.info("[cdp-proxy] debugger detached", { targetId, reason });
      this.handleDebuggerDetach(targetId);
    };

    const target: AttachedTarget = {
      targetId,
      webContents,
      proxySessionId,
      electronSessionId: null,
      defaultContextId: null,
      defaultContextEmitted: false,
      rootFrameId: null,
      detached: false,
      onDebuggerMessage,
      onDebuggerDetach,
    };

    this.targets.set(targetId, target);
    this.proxySessionToTarget.set(proxySessionId, targetId);

    webContents.debugger.on("message", onDebuggerMessage);
    webContents.debugger.on("detach", onDebuggerDetach);

    return { proxySessionId };
  }

  detachDebugger(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target || target.detached) {
      return;
    }
    target.detached = true;
    this.removeDebuggerListeners(target);

    releaseSharedDebugger(targetId);
    this.proxySessionToTarget.delete(target.proxySessionId);
    if (target.electronSessionId) {
      this.electronSessionToProxy.delete(target.electronSessionId);
    }
    this.targets.delete(targetId);
  }

  async sendCommand(
    proxySessionId: string,
    method: string,
    params: object,
  ): Promise<object> {
    const targetId = this.proxySessionToTarget.get(proxySessionId);
    if (!targetId) {
      throw new Error(`Unknown session: ${proxySessionId}`);
    }
    const target = this.targets.get(targetId);
    if (!target || target.detached) {
      throw new Error(`Target detached: ${targetId}`);
    }

    console.info("[cdp-proxy] forward", {
      method,
      targetId,
      proxySessionId,
      url: target.webContents.getURL(),
      timestamp: Date.now(),
    });

    if (shouldMarkTerminalBrowserMcpActivity(method)) {
      markTerminalBrowserMcpActivity(targetId);
    }

    const commandParams = this.rewriteCommandParamsForElectron(
      target,
      params,
    );
    const result = await target.webContents.debugger.sendCommand(
      method,
      commandParams,
      target.electronSessionId ?? undefined,
    );
    const safeResult = (result as object) ?? {};
    if (method === "Page.getFrameTree") {
      target.rootFrameId = this.getRootFrameId(safeResult);
    }
    if (method === "Runtime.enable") {
      this.emitDefaultExecutionContext(target);
    }
    return this.rewriteFrameIdsForClient(target, safeResult);
  }

  getProxySessionId(targetId: string): string | null {
    return this.targets.get(targetId)?.proxySessionId ?? null;
  }

  getTargetIdForSession(proxySessionId: string): string | null {
    return this.proxySessionToTarget.get(proxySessionId) ?? null;
  }

  getAttachedTargetIds(): string[] {
    return [...this.targets.values()]
      .filter((target) => !target.detached)
      .map((target) => target.targetId);
  }

  isTargetAttached(targetId: string): boolean {
    const target = this.targets.get(targetId);
    return target !== undefined && !target.detached;
  }

  cleanup(): void {
    for (const targetId of [...this.targets.keys()]) {
      this.detachDebugger(targetId);
    }
    this.messageRelay = null;
  }

  private handleDebuggerMessage(
    targetId: string,
    method: string,
    params: object,
    electronSessionId?: string,
  ): void {
    const target = this.targets.get(targetId);
    if (!target || target.detached) {
      return;
    }

    let proxySessionId = target.proxySessionId;

    if (electronSessionId) {
      const existingProxy = this.electronSessionToProxy.get(electronSessionId);
      if (existingProxy) {
        proxySessionId = existingProxy;
      } else {
        this.electronSessionToProxy.set(electronSessionId, proxySessionId);
        if (!target.electronSessionId) {
          target.electronSessionId = electronSessionId;
        }
      }
    }

    if (method === "Runtime.executionContextCreated") {
      this.handleExecutionContextCreated(target, params);
    }

    if (this.messageRelay) {
      const event: Record<string, unknown> = {
        method,
        params: this.rewriteFrameIdsForClient(target, params),
        sessionId: proxySessionId,
      };
      this.messageRelay(event);
    }
  }

  private handleDebuggerDetach(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target || target.detached) {
      return;
    }
    target.detached = true;
    this.removeDebuggerListeners(target);
    clearSharedDebugger(targetId);

    if (this.messageRelay) {
      this.messageRelay({
        method: "Inspector.detached",
        params: { reason: "target_closed" },
        sessionId: target.proxySessionId,
      });
    }

    this.proxySessionToTarget.delete(target.proxySessionId);
    if (target.electronSessionId) {
      this.electronSessionToProxy.delete(target.electronSessionId);
    }
    this.targets.delete(targetId);
  }

  private removeDebuggerListeners(target: AttachedTarget): void {
    target.webContents.debugger.off("message", target.onDebuggerMessage);
    target.webContents.debugger.off("detach", target.onDebuggerDetach);
  }

  private emitDefaultExecutionContext(target: AttachedTarget): void {
    if (target.defaultContextEmitted || !this.messageRelay) {
      return;
    }

    target.defaultContextId = nextSyntheticContextId++;
    target.defaultContextEmitted = true;
    this.messageRelay({
      method: "Runtime.executionContextCreated",
      params: {
        context: {
          id: target.defaultContextId,
          origin: target.webContents.getURL(),
          name: "",
          uniqueId: `runweave-default-${target.proxySessionId}`,
          auxData: {
            frameId: target.targetId,
            isDefault: true,
            type: "default",
          },
        },
      },
      sessionId: target.proxySessionId,
    });
  }

  private handleExecutionContextCreated(
    target: AttachedTarget,
    params: object,
  ): void {
    const context = (
      params as {
        context?: { id?: unknown; auxData?: { isDefault?: unknown } };
      }
    ).context;
    if (context?.auxData?.isDefault !== true || typeof context.id !== "number") {
      return;
    }
    target.defaultContextId = context.id;
    target.defaultContextEmitted = true;
  }

  private getRootFrameId(result: object): string | null {
    const frameTree = (result as { frameTree?: { frame?: { id?: unknown } } })
      .frameTree;
    const frameId = frameTree?.frame?.id;
    return typeof frameId === "string" ? frameId : null;
  }

  private rewriteFrameIdsForElectron(
    target: AttachedTarget,
    value: object,
  ): object {
    if (!target.rootFrameId) {
      return value;
    }
    return this.rewriteStringValues(value, target.targetId, target.rootFrameId);
  }

  private rewriteFrameIdsForClient(
    target: AttachedTarget,
    value: object,
  ): object {
    if (!target.rootFrameId) {
      return value;
    }
    return this.rewriteStringValues(value, target.rootFrameId, target.targetId);
  }

  private rewriteCommandParamsForElectron(
    target: AttachedTarget,
    value: object,
  ): object {
    const withFrameIds = this.rewriteFrameIdsForElectron(target, value);
    if (!target.defaultContextId) {
      return withFrameIds;
    }
    return this.omitSyntheticDefaultContextId(
      withFrameIds,
      target.defaultContextId,
    );
  }

  private omitSyntheticDefaultContextId(value: object, contextId: number): object {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "contextId" || key === "executionContextId") &&
        child === contextId
      ) {
        continue;
      }
      next[key] = child;
    }
    return next;
  }

  private rewriteStringValues(value: unknown, from: string, to: string): object {
    return this.rewriteStringValue(value, from, to) as object;
  }

  private rewriteStringValue(value: unknown, from: string, to: string): unknown {
    if (typeof value === "string") {
      return value === from ? to : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.rewriteStringValue(item, from, to));
    }
    if (value && typeof value === "object") {
      const next: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        next[key] = this.rewriteStringValue(child, from, to);
      }
      return next;
    }
    return value;
  }
}
