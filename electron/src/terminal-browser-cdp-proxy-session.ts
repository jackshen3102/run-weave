import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  getTerminalBrowserEntryByTargetId,
  setTerminalBrowserCdpProxyAttached,
} from "./terminal-browser-view.js";

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

    const found = getTerminalBrowserEntryByTargetId(targetId);
    if (found?.entry.devtoolsOpen) {
      throw new Error("DevTools is already open for this browser tab");
    }

    try {
      webContents.debugger.attach("1.3");
    } catch (error) {
      throw new Error(
        `Failed to attach debugger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    setTerminalBrowserCdpProxyAttached(targetId, true);

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

    try {
      target.webContents.debugger.detach();
    } catch {
      // Already detached.
    }

    setTerminalBrowserCdpProxyAttached(targetId, false);
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

    const commandParams = this.rewriteFrameIdsForElectron(target, params);
    const result = await target.webContents.debugger.sendCommand(
      method,
      commandParams,
      target.electronSessionId ?? undefined,
    );
    const safeResult = (result as object) ?? {};
    if (method === "Page.getFrameTree") {
      target.rootFrameId = this.getRootFrameId(safeResult);
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
    setTerminalBrowserCdpProxyAttached(targetId, false);

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
