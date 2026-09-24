import { timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import type { DesktopBrowserBindingRequest, RemoteBrowserResolveRequest } from "@runweave/shared/remote";
import { createRequireAuth, readBearerToken } from "../auth/middleware";
import type { AuthService } from "../auth/service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { DesktopBrowserBindings, RemoteBrowserError } from "./browser-bindings";
import { registerRemoteCapabilitiesRoute } from "./capabilities";

function matchesHookToken(value: unknown, expected: string | undefined): boolean {
  if (typeof value !== "string" || !expected) return false;
  const supplied = Buffer.from(value);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

function sendError(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown): void {
  if (error instanceof RemoteBrowserError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  res.status(503).json({ code: "DESKTOP_UNAVAILABLE", message: "Remote Browser bridge failed" });
}

export function registerRemoteBrowserRoutes(
  app: Express,
  auth: AuthService,
  sessions: TerminalSessionManager,
  requireTunnelAuth: Parameters<typeof registerRemoteCapabilitiesRoute>[1],
  browserProfileDir: string,
  backendId: string,
): void {
  const bindings = new DesktopBrowserBindings(sessions);
  const requireAuth = createRequireAuth(auth);
  registerRemoteCapabilitiesRoute(app, requireTunnelAuth, requireAuth, browserProfileDir, backendId);
  app.post("/api/desktop-browser/bindings", requireAuth, async (req, res) => {
    const owner = auth.verifyAccessToken(readBearerToken(req) ?? "")?.sessionId;
    if (!owner) { res.sendStatus(401); return; }
    try {
      res.status(201).json(await bindings.bind(owner, req.body as DesktopBrowserBindingRequest));
    } catch (error) { sendError(res, error); }
  });
  app.delete("/api/desktop-browser/bindings/:id", requireAuth, (req, res) => {
    const owner = auth.verifyAccessToken(readBearerToken(req) ?? "")?.sessionId;
    if (!owner) { res.sendStatus(401); return; }
    try {
      bindings.unbind(owner, String(req.params.id));
      res.sendStatus(204);
    } catch (error) { sendError(res, error); }
  });
  app.post("/api/terminal/session/:id/browser/capability", (req, res) => {
    if (!matchesHookToken(req.headers["x-runweave-hook-token"], process.env.RUNWEAVE_HOOK_TOKEN)) {
      res.sendStatus(401); return;
    }
    const projectId = req.body?.projectId;
    if (typeof projectId !== "string") { res.sendStatus(400); return; }
    try {
      res.json({ capability: bindings.issueCapability(req.params.id, projectId), expiresIn: 3600 });
    } catch (error) { sendError(res, error); }
  });
  app.post("/api/terminal/session/:id/browser/resolve", async (req, res) => {
    const capability = readBearerToken(req);
    if (!capability) { res.sendStatus(401); return; }
    try {
      res.json(await bindings.resolve(req.params.id, capability, req.body as RemoteBrowserResolveRequest));
    } catch (error) { sendError(res, error); }
  });
}
