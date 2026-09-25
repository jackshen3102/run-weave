import { isRemoteBrowserProfileState } from "@runweave/shared/remote";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  DesktopBrowserBinding,
  DesktopBrowserBindingRequest,
  RemoteBrowserResolveRequest,
  RemoteBrowserResolveResponse,
  RemoteBrowserGatewayResponse,
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
  bindingId: string;
  generation: number;
}

export class RemoteBrowserError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class DesktopBrowserBindings {
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly terminalBindings = new Map<
    string,
    { desktopId: string; hostId: string; ownerSessionId: string }
  >();
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(private readonly sessions: TerminalSessionManager) {}

  async bind(
    ownerSessionId: string,
    input: DesktopBrowserBindingRequest,
  ): Promise<DesktopBrowserBinding> {
    if (
      !input ||
      input.protocolVersion !== 2 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.desktopId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.hostId) ||
      !Number.isInteger(input.generation) ||
      input.generation < 1 ||
      !Number.isInteger(input.reversePort) ||
      input.reversePort < 1 ||
      input.reversePort > 65535 ||
      !/^[0-9a-f]{64}$/.test(input.gatewayKey)
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        400,
        "Invalid desktop binding",
      );
    }
    let challenge: Response;
    try {
      challenge = await fetch(`http://127.0.0.1:${input.reversePort}/check`, {
        headers: { "x-runweave-gateway-key": input.gatewayKey },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      throw new RemoteBrowserError(
        "DESKTOP_UNAVAILABLE",
        503,
        "Desktop Browser bridge is unreachable",
      );
    }
    const identity = challenge.ok
      ? ((await challenge.json().catch(() => null)) as {
          protocolVersion?: unknown;
          desktopId?: unknown;
          hostId?: unknown;
          generation?: unknown;
        } | null)
      : null;
    if (
      identity?.protocolVersion !== 2 ||
      identity.desktopId !== input.desktopId ||
      identity.hostId !== input.hostId ||
      identity.generation !== input.generation
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        403,
        "Desktop bridge identity does not match",
      );
    }
    let existingId: string | undefined;
    for (const [id, binding] of this.bindings) {
      if (
        binding.ownerSessionId === ownerSessionId &&
        binding.desktopId === input.desktopId &&
        binding.hostId === input.hostId
      ) {
        if (binding.generation === input.generation) existingId = id;
        this.bindings.delete(id);
      }
    }
    const record: BindingRecord = {
      id: existingId ?? randomUUID(),
      protocolVersion: 2,
      ownerSessionId,
      desktopId: input.desktopId,
      hostId: input.hostId,
      generation: input.generation,
      reversePort: input.reversePort,
      gatewayKey: input.gatewayKey,
      registeredAt: Date.now(),
    };
    this.bindings.set(record.id, record);
    return this.publicBinding(record);
  }

  unbind(ownerSessionId: string, id: string): void {
    const binding = this.bindings.get(id);
    if (!binding || binding.ownerSessionId !== ownerSessionId) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        404,
        "Desktop binding not found",
      );
    }
    this.bindings.delete(id);
  }

  private publicBinding(binding: BindingRecord): DesktopBrowserBinding {
    return {
      protocolVersion: 2,
      id: binding.id,
      desktopId: binding.desktopId,
      hostId: binding.hostId,
      generation: binding.generation,
    };
  }
  private liveBindings(): BindingRecord[] {
    for (const [id, binding] of this.bindings)
      if (Date.now() - binding.registeredAt >= 60_000) this.bindings.delete(id);
    return [...this.bindings.values()];
  }
  list(ownerSessionId: string): DesktopBrowserBinding[] {
    return this.liveBindings()
      .filter((binding) => binding.ownerSessionId === ownerSessionId)
      .map((binding) => this.publicBinding(binding));
  }
  select(
    ownerSessionId: string,
    terminalSessionId: string,
    bindingId: string,
  ): void {
    if (!this.sessions.getSession(terminalSessionId))
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        404,
        "Terminal not found",
      );
    const binding = this.liveBindings().find(
      (candidate) =>
        candidate.id === bindingId &&
        candidate.ownerSessionId === ownerSessionId,
    );
    if (!binding)
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        403,
        "Desktop binding is not owned by this session",
      );
    const previous = this.terminalBindings.get(terminalSessionId);
    if (
      previous &&
      (previous.desktopId !== binding.desktopId ||
        previous.hostId !== binding.hostId ||
        previous.ownerSessionId !== binding.ownerSessionId) &&
      this.liveBindings().some(
        (candidate) =>
          candidate.desktopId === previous.desktopId &&
          candidate.hostId === previous.hostId &&
          candidate.ownerSessionId === previous.ownerSessionId,
      )
    ) {
      throw new RemoteBrowserError(
        "BROWSER_BINDING_CONFLICT",
        409,
        "Terminal already belongs to another desktop",
      );
    }
    this.terminalBindings.set(terminalSessionId, {
      desktopId: binding.desktopId,
      hostId: binding.hostId,
      ownerSessionId: binding.ownerSessionId,
    });
  }
  private selectedBinding(terminalSessionId: string): BindingRecord {
    const candidates = this.liveBindings();
    const owner = this.terminalBindings.get(terminalSessionId);
    const selected = candidates.find(
      (binding) =>
        binding.desktopId === owner?.desktopId &&
        binding.hostId === owner.hostId &&
        binding.ownerSessionId === owner.ownerSessionId,
    );
    if (selected) return selected;
    if (this.terminalBindings.has(terminalSessionId))
      throw new RemoteBrowserError(
        "DESKTOP_UNAVAILABLE",
        503,
        "Selected desktop is offline; select its new binding before continuing",
      );
    throw new RemoteBrowserError(
      candidates.length ? "BROWSER_BINDING_REQUIRED" : "DESKTOP_UNAVAILABLE",
      503,
      candidates.length
        ? "Select a desktop Browser binding for this terminal"
        : "No desktop Browser is connected",
    );
  }

  issueCapability(terminalSessionId: string, projectId: string): string {
    const session = this.sessions.getSession(terminalSessionId);
    if (
      !session ||
      session.projectId !== projectId ||
      session.status === "exited"
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        403,
        "Terminal identity does not match",
      );
    }
    for (const [token, record] of this.capabilities) {
      if (record.expiresAt < Date.now()) this.capabilities.delete(token);
    }
    const existingForTerminal = [...this.capabilities].filter(
      ([, record]) => record.terminalSessionId === terminalSessionId,
    );
    for (const [token] of existingForTerminal.slice(
      0,
      Math.max(0, existingForTerminal.length - 7),
    )) {
      this.capabilities.delete(token);
    }
    const binding = this.selectedBinding(terminalSessionId);
    const token = randomBytes(32).toString("hex");
    this.capabilities.set(token, {
      bindingId: binding.id,
      generation: binding.generation,
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
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        400,
        "Invalid Browser request",
      );
    }
    const record = this.capabilities.get(capability);
    const session = this.sessions.getSession(terminalSessionId);
    if (
      !record ||
      !session ||
      record.expiresAt < Date.now() ||
      record.terminalSessionId !== terminalSessionId ||
      record.projectId !== session.projectId ||
      request.projectId !== session.projectId ||
      session.status === "exited"
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        403,
        "Terminal Browser capability is invalid",
      );
    }
    if (
      request.explicitProfileId !== null &&
      !["profile-1", "profile-2", "profile-3"].includes(
        request.explicitProfileId,
      )
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        400,
        "Invalid Browser Profile",
      );
    }
    if (
      request.browserGroupId !== null &&
      (typeof request.browserGroupId !== "string" ||
        !request.browserGroupId ||
        request.browserGroupId.length > 512)
    ) {
      throw new RemoteBrowserError(
        "BROWSER_SCOPE_DENIED",
        400,
        "Invalid Browser group",
      );
    }
    const binding = this.liveBindings().find(
      (candidate) =>
        candidate.id === record.bindingId &&
        candidate.generation === record.generation,
    );
    if (!binding)
      throw new RemoteBrowserError(
        "DESKTOP_UNAVAILABLE",
        503,
        "Desktop Browser binding expired; resolve again",
      );
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${binding.reversePort}/issue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-runweave-gateway-key": binding.gatewayKey,
        },
        body: JSON.stringify({
          desktopId: binding.desktopId,
          hostId: binding.hostId,
          generation: binding.generation,
          projectId: session.projectId,
          terminalSessionId,
          explicitProfileId: request.explicitProfileId,
          browserGroupId: request.browserGroupId,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new RemoteBrowserError(
        "DESKTOP_UNAVAILABLE",
        503,
        "Desktop Browser is unreachable",
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | (Partial<RemoteBrowserGatewayResponse> & { code?: unknown })
      | null;
    if (
      !response.ok ||
      !isRemoteBrowserProfileState(payload) ||
      typeof payload?.ticket !== "string" ||
      typeof payload.profileId !== "string" ||
      typeof payload.browserGroupId !== "string"
    ) {
      throw new RemoteBrowserError(
        typeof payload?.code === "string"
          ? payload.code
          : "DESKTOP_UNAVAILABLE",
        response.status >= 400 ? response.status : 503,
        "Desktop Browser scope could not be resolved",
      );
    }
    return {
      protocolVersion: 2,
      binding: this.publicBinding(binding),
      profileId: payload.profileId as RemoteBrowserResolveResponse["profileId"],
      browserGroupId: payload.browserGroupId,
      cdpEndpoint: `ws://127.0.0.1:${binding.reversePort}/ticket/${payload.ticket}`,
      expiresIn: 60,
      source: payload.source,
      route: payload.route,
      whistle: payload.whistle,
    };
  }
}
