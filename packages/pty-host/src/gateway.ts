import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import type { PtyHostSession, PtyHostUpstreams } from "@runweave/shared/terminal/pty-host";
import { EventOutbox } from "./event-outbox";

const backendPaths = new Set(["/internal/terminal/agent-hook", "/internal/terminal-completion", "/internal/task-supervision", "/internal/task-supervision/validate"]);
const appRead = /^(?:\/healthz|\/readyz|\/events(?:\/latest)?|\/runtime-status|\/codex\/quota|\/sync\/status|\/threads(?:\/previews|\/[a-zA-Z0-9_-]+(?:\/(?:conversation|detail|supervision-context|analysis-evidence))?)?)$/;

export function isGatewayCredential(actual: string, expected: string): boolean {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function validateUpstream(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("HOST_UPSTREAM_INVALID");
}

export class HostGateway {
  readonly outbox: EventOutbox;
  private upstreams: PtyHostUpstreams | undefined;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(error => {
      if (!response.headersSent) response.writeHead((error as Error).message === "HOST_OUTBOX_FULL" ? 507 : 400);
      response.end(JSON.stringify({ error: (error as Error).message }));
    });
  });
  private timer: ReturnType<typeof setInterval> | undefined;
  url = "";

  constructor(private readonly scope: EnvironmentContext, root: string, private readonly sessions: () => PtyHostSession[]) {
    this.outbox = new EventOutbox(root);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("HOST_GATEWAY_START_FAILED");
    this.url = `http://127.0.0.1:${address.port}/`;
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, 1000);
    this.timer.unref();
  }

  setUpstreams(upstreams: PtyHostUpstreams): void {
    validateUpstream(upstreams.backendUrl);
    validateUpstream(upstreams.appServerUrl);
    if (!upstreams.backendToken || !upstreams.appServerToken) throw new Error("HOST_UPSTREAM_INVALID");
    this.upstreams = { ...upstreams, backendUrl: upstreams.backendUrl.replace(/\/$/, ""), appServerUrl: upstreams.appServerUrl.replace(/\/$/, "") };
    void this.flush().catch(() => {});
  }

  launchEnvironment(token: string): Record<string, string> {
    return {
      RUNWEAVE_APP_SERVER_URL: `${this.url}app-server`, RUNWEAVE_APP_SERVER_TOKEN: token,
      RUNWEAVE_HOOK_ENDPOINT: `${this.url}backend/internal/terminal/agent-hook`,
      RUNWEAVE_COMPLETION_HOOK_ENDPOINT: `${this.url}backend/internal/terminal-completion`, RUNWEAVE_HOOK_TOKEN: token,
    };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private flush(): Promise<void> {
    return this.outbox.drain(async body => {
      if (!this.upstreams) return false;
      try {
        const response = await fetch(this.upstreams.appServerUrl + "/events", {
          method: "POST", headers: { authorization: `Bearer ${this.upstreams.appServerToken}`, "content-type": "application/json" },
          body, redirect: "error", signal: AbortSignal.timeout(5000),
        });
        return response.status === 400 || response.status === 422 ? "rejected" : response.ok;
      } catch { return false; }
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.headers.origin || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
      response.writeHead(403); response.end(); return;
    }
    const url = new URL(request.url ?? "/", this.url);
    const app = url.pathname.startsWith("/app-server/");
    const route = app ? url.pathname.slice("/app-server".length)
      : url.pathname.startsWith("/backend/") ? url.pathname.slice("/backend".length) : url.pathname;
    // Hook discovery deliberately probes health before supplying its credential.
    // This is event-ingress health, not readiness of the replaceable upstream.
    if (app && route === "/healthz" && request.method === "GET") {
      response.end(JSON.stringify({ ok: true, service: "runweave-app-server", protocolVersion: 1, pid: process.pid,
        environment: this.scope, gateway: true, eventIngressAvailable: !this.outbox.incomplete }));
      return;
    }
    const credential = (request.headers.authorization ?? "").replace(/^Bearer /, "") || String(request.headers["x-runweave-hook-token"] ?? "");
    const session = this.sessions().find(item => isGatewayCredential(credential, item.gatewayToken));
    if (!session) { response.writeHead(403); response.end(); return; }
    const allowed = app ? request.method === "GET" && appRead.test(route) || request.method === "POST" && route === "/events"
      : request.method === "POST" && backendPaths.has(route);
    if (!allowed || url.searchParams.has("url")) { response.writeHead(404); response.end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("HOST_EVENT_TOO_LARGE");
    }
    if (request.method === "POST") {
      const message = JSON.parse(body) as Record<string, unknown>;
      const scope = message.scope as { terminalSessionId?: string; projectId?: string } | undefined;
      if ((scope?.terminalSessionId ?? message.terminalSessionId) !== session.terminalSessionId ||
        scope?.projectId && scope.projectId !== session.projectId || message.projectId && message.projectId !== session.projectId) {
        response.writeHead(403); response.end(); return;
      }
      if (app && route === "/events") {
        this.outbox.accept(message);
        response.writeHead(202); response.end(JSON.stringify({ accepted: true }));
        void this.flush().catch(() => {});
        return;
      }
    }
    if (!this.upstreams) { response.writeHead(503); response.end(JSON.stringify({ error: "HOST_UPSTREAM_UNAVAILABLE" })); return; }
    try {
      const upstream = await fetch((app ? this.upstreams.appServerUrl : this.upstreams.backendUrl) + route + url.search, {
        method: request.method, headers: app
          ? { authorization: `Bearer ${this.upstreams.appServerToken}`, "content-type": "application/json" }
          : { "x-runweave-hook-token": this.upstreams.backendToken, "content-type": "application/json" },
        ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      response.writeHead(upstream.status);
      response.end(await upstream.text());
    } catch { response.writeHead(503); response.end(JSON.stringify({ error: "HOST_UPSTREAM_UNAVAILABLE" })); }
  }
}
