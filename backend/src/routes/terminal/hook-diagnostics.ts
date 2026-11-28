import { realpathSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { TerminalSessionManager } from "../../terminal/manager/manager";
import type { HookDiagnosticService } from "../../terminal/hook-diagnostics/service";
import type { TmuxService } from "../../terminal/tmux/service";

const source = z.enum([
  "claude",
  "codex",
  "trae",
  "traecli",
  "traex",
  "pi",
  "agy",
  "unknown",
]);
const printableToken = (maxLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) =>
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    );
const sessionToken = printableToken(128);
const socketToken = printableToken(512);
const body = z
  .object({
    terminalSessionId: z.string().trim().min(1).max(128),
    source,
    reason: z.literal("foreign_tmux_session"),
    expectedSession: sessionToken,
    actualSession: sessionToken,
    expectedSocket: socketToken.optional(),
    actualSocket: socketToken.optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .strict();

function normalizeSocketPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function createHookDiagnosticsRouter(options: {
  hookToken: string | undefined;
  terminalSessionManager: TerminalSessionManager;
  tmuxService: TmuxService;
  diagnostics: HookDiagnosticService;
}): Router {
  const router = Router();
  router.post("/", (req, res) => {
    const token = options.hookToken?.trim();
    if (!token) {
      res.status(503).json({ message: "Hook diagnostics unavailable" });
      return;
    }
    if (req.header("x-runweave-hook-token") !== token) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body" });
      return;
    }
    const session = options.terminalSessionManager.getSession(
      parsed.data.terminalSessionId,
    );
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    const expected =
      session.tmuxSessionName ??
      options.tmuxService.buildSessionName(session.id);
    if (parsed.data.expectedSession !== expected) {
      res.status(409).json({ message: "Terminal session identity changed" });
      return;
    }
    const expectedSocket = session.tmuxSocketPath ?? options.tmuxService.socketPath;
    const normalizedExpectedSocket = parsed.data.expectedSocket
      ? normalizeSocketPath(parsed.data.expectedSocket)
      : null;
    if (
      normalizedExpectedSocket &&
      normalizedExpectedSocket !== normalizeSocketPath(expectedSocket)
    ) {
      res.status(409).json({ message: "Terminal session identity changed" });
      return;
    }
    const normalizedActualSocket = parsed.data.actualSocket
      ? normalizeSocketPath(parsed.data.actualSocket)
      : null;
    const isForeignSession = parsed.data.actualSession !== expected;
    const isForeignSocket = Boolean(
      normalizedExpectedSocket &&
        normalizedActualSocket &&
        normalizedActualSocket !== normalizedExpectedSocket,
    );
    if (!isForeignSession && !isForeignSocket) {
      res.status(400).json({ message: "Foreign session required" });
      return;
    }
    options.diagnostics.recordForeign({
      ...parsed.data,
      expectedSocket: normalizedExpectedSocket ?? undefined,
      actualSocket: normalizedActualSocket ?? undefined,
    });
    res.status(202).json({ accepted: true });
  });
  return router;
}
