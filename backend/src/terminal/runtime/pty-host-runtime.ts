import { randomUUID } from "node:crypto";
import { logger } from "../../logging/index";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import type { TerminalRuntimeRegistry } from "./registry";
import { createHostedPty, getPtyHost, usesPtyHost } from "./pty-host-client";
import { buildPtyEnv, type PtyRuntime } from "./pty-service";
import { buildTerminalRuntimeEnvironment } from "./environment";
import { createTerminalRuntimeRecorder } from "./recorder";

const launches = new Map<string, Promise<PtyRuntime>>();
export function ensureHostedTerminal(options: { session: TerminalSessionRecord; terminalSessionManager: TerminalSessionManager; runtimeRegistry: TerminalRuntimeRegistry }): Promise<PtyRuntime> {
  const previous = launches.get(options.session.id);
  if (previous) return previous;
  const launch = (async () => {
    const { session, terminalSessionManager, runtimeRegistry } = options;
    const existing = runtimeRegistry.getSessionRuntime(session.id);
    if (existing) return existing;
    let binding = session.ptyHost;
    const creating = !binding;
    if (!binding) {
      binding = { hostInstanceId: (await getPtyHost()).descriptor.hostInstanceId, sessionInstanceId: randomUUID() };
      await terminalSessionManager.updateRuntimeMetadata(session.id, { runtimeKind: "pty", ptyHost: binding, recoverable: true });
    }
    const runtime = await createHostedPty({ terminalSessionId: session.id, binding,
      create: creating ? { sessionInstanceId: binding.sessionInstanceId, terminalSessionId: session.id, projectId: session.projectId,
        command: session.command, args: session.args, cwd: session.cwd, cols: 80, rows: 24,
        env: buildPtyEnv(process.env, buildTerminalRuntimeEnvironment({ terminalSessionId: session.id,
          projectId: session.projectId, source: session.source }), session.command) } : undefined });
    runtimeRegistry.createRuntime(session.id, runtime);
    runtimeRegistry.ensureRecorder(session.id, createTerminalRuntimeRecorder(terminalSessionManager, session.id));
    return runtime;
  })().finally(() => { launches.delete(options.session.id); });
  launches.set(options.session.id, launch);
  return launch;
}
export async function reconcileHostedTerminals(manager: TerminalSessionManager, registry: TerminalRuntimeRegistry): Promise<void> {
  if (!usesPtyHost()) return;
  for (const session of manager.listSessions()) {
    if (session.runtimeKind !== "pty" || session.status !== "running") continue;
    if (!session.ptyHost) { if (session.status === "running") manager.markExited(session.id); continue; }
    try { await ensureHostedTerminal({ session, terminalSessionManager: manager, runtimeRegistry: registry }); }
    catch (error) {
      logger.warn("terminal.pty-host.reconcile.failed", { terminalSessionId: session.id, error });
      if ((error as Error).message === "HOST_SESSION_GONE") manager.markExited(session.id);
    }
  }
}
