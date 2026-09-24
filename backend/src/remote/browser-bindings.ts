import { randomBytes, randomUUID } from "node:crypto";
import type {
  DesktopBrowserBinding,
  DesktopBrowserBindingRequest,
  RemoteBrowserResolveRequest,
  RemoteBrowserResolveResponse,
} from "@runweave/shared/remote";
import type { TerminalSessionManager } from "../terminal/manager/manager";

interface BindingRecord extends DesktopBrowserBinding {
  ownerSessionId: string;
  reversePort: number;
  gatewayKey: string;
  registeredAt: number;
}

interface CapabilityRecord {
  terminalSessionId: string;
  projectId: string;
  expiresAt: number;
}

export class RemoteBrowserError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

export class DesktopBrowserBindings {
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(private readonly sessions: TerminalSessionManager) {}

  async bind(ownerSessionId: string, input: DesktopBrowserBindingRequest): Promise<DesktopBrowserBinding> {
    if (!input || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.connectionId) ||
        !Number.isInteger(input.generation) || input.generation < 1 ||
        !Number.isInteger(input.reversePort) || input.reversePort < 1 || input.reversePort > 65535 ||
        !/^[0-9a-f]{64}$/.test(input.gatewayKey)) {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 400, "Invalid desktop binding");
    }
    let challenge: Response;
    try {
      challenge = await fetch(`http://127.0.0.1:${input.reversePort}/check`, {
        headers: { "x-runweave-gateway-key": input.gatewayKey },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      throw new RemoteBrowserError("DESKTOP_UNAVAILABLE", 503, "Desktop Browser bridge is unreachable");
    }
    const identity = challenge.ok
      ? (await challenge.json().catch(() => null)) as { connectionId?: unknown; generation?: unknown } | null
      : null;
    if (identity?.connectionId !== input.connectionId || identity.generation !== input.generation) {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 403, "Desktop bridge identity does not match");
    }
    for (const [id, binding] of this.bindings) {
      if (binding.ownerSessionId === ownerSessionId && binding.connectionId === input.connectionId) {
        this.bindings.delete(id);
      }
    }
    const record: BindingRecord = {
      id: randomUUID(),
      ownerSessionId,
      connectionId: input.connectionId,
      generation: input.generation,
      reversePort: input.reversePort,
      gatewayKey: input.gatewayKey,
      registeredAt: Date.now(),
    };
    this.bindings.set(record.id, record);
    return { id: record.id, connectionId: record.connectionId, generation: record.generation };
  }

  unbind(ownerSessionId: string, id: string): void {
    const binding = this.bindings.get(id);
    if (!binding || binding.ownerSessionId !== ownerSessionId) {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 404, "Desktop binding not found");
    }
    this.bindings.delete(id);
  }

  issueCapability(terminalSessionId: string, projectId: string): string {
    const session = this.sessions.getSession(terminalSessionId);
    if (!session || session.projectId !== projectId || session.status === "exited") {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 403, "Terminal identity does not match");
    }
    for (const [token, record] of this.capabilities) {
      if (record.expiresAt < Date.now()) this.capabilities.delete(token);
    }
    const existingForTerminal = [...this.capabilities].filter(([, record]) => record.terminalSessionId === terminalSessionId);
    for (const [token] of existingForTerminal.slice(0, Math.max(0, existingForTerminal.length - 7))) {
      this.capabilities.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    this.capabilities.set(token, {
      terminalSessionId,
      projectId,
      expiresAt: Date.now() + 60 * 60_000,
    });
    return token;
  }

  async resolve(
    terminalSessionId: string,
    capability: string,
    request: RemoteBrowserResolveRequest,
  ): Promise<RemoteBrowserResolveResponse> {
    if (!request || typeof request !== "object") {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 400, "Invalid Browser request");
    }
    const record = this.capabilities.get(capability);
    const session = this.sessions.getSession(terminalSessionId);
    if (!record || !session || record.expiresAt < Date.now() ||
        record.terminalSessionId !== terminalSessionId ||
        record.projectId !== session.projectId ||
        request.projectId !== session.projectId || session.status === "exited") {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 403, "Terminal Browser capability is invalid");
    }
    if (request.explicitProfileId !== null &&
        !["profile-1", "profile-2", "profile-3"].includes(request.explicitProfileId)) {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 400, "Invalid Browser Profile");
    }
    if (request.browserGroupId !== null &&
        (typeof request.browserGroupId !== "string" || !request.browserGroupId || request.browserGroupId.length > 512)) {
      throw new RemoteBrowserError("BROWSER_SCOPE_DENIED", 400, "Invalid Browser group");
    }
    const binding = [...this.bindings.values()].sort((a, b) => b.registeredAt - a.registeredAt)[0];
    if (!binding) {
      throw new RemoteBrowserError("DESKTOP_UNAVAILABLE", 503, "No desktop Browser is connected");
    }
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${binding.reversePort}/issue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runweave-gateway-key": binding.gatewayKey,
        },
        body: JSON.stringify({
          connectionId: binding.connectionId,
          generation: binding.generation,
          projectId: session.projectId,
          terminalSessionId,
          explicitProfileId: request.explicitProfileId,
          browserGroupId: request.browserGroupId,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new RemoteBrowserError("DESKTOP_UNAVAILABLE", 503, "Desktop Browser is unreachable");
    }
    const payload = (await response.json().catch(() => null)) as {
      ticket?: unknown; profileId?: unknown; browserGroupId?: unknown; code?: unknown;
    } | null;
    if (!response.ok || typeof payload?.ticket !== "string" ||
        typeof payload.profileId !== "string" || typeof payload.browserGroupId !== "string") {
      throw new RemoteBrowserError(
        typeof payload?.code === "string" ? payload.code : "DESKTOP_UNAVAILABLE",
        response.status >= 400 ? response.status : 503,
        "Desktop Browser scope could not be resolved",
      );
    }
    return {
      profileId: payload.profileId as RemoteBrowserResolveResponse["profileId"],
      browserGroupId: payload.browserGroupId,
      cdpEndpoint: `ws://127.0.0.1:${binding.reversePort}/ticket/${payload.ticket}`,
      expiresIn: 60,
    };
  }
}
