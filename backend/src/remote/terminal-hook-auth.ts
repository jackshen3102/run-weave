import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { PtyHostSession } from "@runweave/shared/terminal/pty-host";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { getPtyHost, usesPtyHost } from "../terminal/runtime/pty-host-client";

function matchesToken(value: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const supplied = Buffer.from(value);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

async function authenticatesTerminal(
  value: unknown,
  terminalId: string,
  sessions: TerminalSessionManager,
): Promise<boolean> {
  if (typeof value !== "string" || !value) return false;
  if (matchesToken(value, process.env.RUNWEAVE_HOOK_TOKEN)) return true;
  if (!usesPtyHost()) return false;
  const session = sessions.getSession(terminalId);
  const binding = session?.ptyHost;
  if (!binding || session.status !== "running") return false;
  const host = await getPtyHost();
  if (host.descriptor.hostInstanceId !== binding.hostInstanceId) return false;
  // Hosted shells inherit a per-session gateway token, not the Backend hook token.
  // Read it over the authenticated Host pipe and keep its authority terminal-local.
  const hosted = (await host.request<PtyHostSession[]>("listSessions")).find(
    (item) => item.terminalSessionId === terminalId &&
      item.hostInstanceId === binding.hostInstanceId &&
      item.sessionInstanceId === binding.sessionInstanceId,
  );
  return hosted?.status === "running" && matchesToken(value, hosted.gatewayToken);
}

export function createRequireTerminalHook(sessions: TerminalSessionManager): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!await authenticatesTerminal(req.headers["x-runweave-hook-token"], String(req.params.id), sessions)) {
        res.sendStatus(401);
        return;
      }
      next();
    } catch {
      res.status(503).json({ code: "DESKTOP_UNAVAILABLE", message: "Terminal runtime authentication is unavailable" });
    }
  };
}
