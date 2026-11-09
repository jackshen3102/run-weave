import { randomUUID } from "node:crypto";
import { isInteractiveShellLaunch } from "@runweave/shared/terminal/shell";
import { logger } from "../../logging/index";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import type { TerminalRuntimeRegistry } from "./registry";
import { createHostedPty, getPtyHost, usesPtyHost } from "./pty-host-client";
import { buildPtyEnv, type PtyRuntime } from "./pty-service";
import { buildTerminalRuntimeEnvironment } from "./environment";
import { createTerminalRuntimeRecorder } from "./recorder";
import { resolveDefaultTerminalLaunchConfig, resolveTerminalFallbackLaunchConfig } from "./default-shell";
import { buildAgentResumeCommand, getAgentAdapter } from "./agent-adapters";
import { recordTerminalRebuildAttempt, resolveAgentThreadToResume, TerminalRebuildLimitError } from "./recovery-policy";

type HostedTerminalOptions = {
  session: TerminalSessionRecord;
  terminalSessionManager: TerminalSessionManager;
  runtimeRegistry: TerminalRuntimeRegistry;
};
type HostedTerminalResult = { runtime: PtyRuntime; warning?: string };
const launches = new Map<string, Promise<HostedTerminalResult>>();
const rebuildAttempts = new Map<string, number[]>();

export function ensureHostedTerminal(options: HostedTerminalOptions): Promise<HostedTerminalResult> {
  const previous = launches.get(options.session.id);
  if (previous) return previous;
  const launch = attachOrRebuild(options).finally(() => { launches.delete(options.session.id); });
  launches.set(options.session.id, launch);
  return launch;
}

async function attachOrRebuild(options: HostedTerminalOptions): Promise<HostedTerminalResult> {
  const { session, terminalSessionManager, runtimeRegistry } = options;
  const existing = runtimeRegistry.getSessionRuntime(session.id);
  if (existing) return { runtime: existing };
  let runtime: PtyRuntime;
  let warning: string | undefined;
  try {
    runtime = await launchHostedTerminal(options, !session.ptyHost);
  } catch (error) {
    // Only a verified replacement Host or an authenticated missing-session reply
    // proves loss. Timeouts, writer/authentication and binding conflicts fail closed.
    if (!(error instanceof Error) || error.message !== "HOST_SESSION_GONE" || session.status !== "running") throw error;
    ({ runtime, warning } = await rebuildHostedTerminal(options));
  }
  runtimeRegistry.createRuntime(session.id, runtime);
  runtimeRegistry.ensureRecorder(session.id, createTerminalRuntimeRecorder(terminalSessionManager, session.id));
  return { runtime, warning };
}

async function launchHostedTerminal(options: HostedTerminalOptions, creating: boolean): Promise<PtyRuntime> {
  const { session, terminalSessionManager } = options;
  let binding = session.ptyHost;
  if (creating) {
    binding = { hostInstanceId: (await getPtyHost()).descriptor.hostInstanceId, sessionInstanceId: randomUUID() };
    await terminalSessionManager.updateRuntimeMetadata(session.id, { runtimeKind: "pty", ptyHost: binding, recoverable: true });
  }
  if (!binding) throw new Error("HOST_SESSION_GONE");
  const fallback = creating ? resolveTerminalFallbackLaunchConfig(session) : null;
  const terminalEnv = buildTerminalRuntimeEnvironment({ terminalSessionId: session.id, projectId: session.projectId, source: session.source });
  return createHostedPty({ terminalSessionId: session.id, binding,
    onLaunch: async launch => {
      if (launch.fallbackReason) logger.warn("terminal.pty-host.fallback.activated", { terminalSessionId: session.id, command: launch.command, reason: launch.fallbackReason });
      await terminalSessionManager.updateSessionLaunch(session.id, { command: launch.command, args: launch.args });
    },
    create: creating ? { sessionInstanceId: binding.sessionInstanceId, terminalSessionId: session.id, projectId: session.projectId,
      command: session.command, args: session.args, cwd: session.cwd, cols: 80, rows: 24,
      env: buildPtyEnv(process.env, terminalEnv, session.command),
      ...(fallback ? { fallback: { ...fallback, env: buildPtyEnv(process.env, terminalEnv, fallback.command) } } : {}) } : undefined });
}

async function rebuildHostedTerminal(options: HostedTerminalOptions): Promise<HostedTerminalResult> {
  const { session, terminalSessionManager } = options;
  const interactive = isInteractiveShellLaunch(session);
  const thread = interactive ? resolveAgentThreadToResume(session) : null;
  let warning = "Command exited; returned to a shell.";
  if (interactive) {
    try {
      const attempt = recordTerminalRebuildAttempt(rebuildAttempts, session.id);
      warning = thread
        ? `Original PTY Host session was lost; starting ${thread.provider} resume from saved threadId (${attempt.count}/${attempt.maxAttempts}).`
        : `Original PTY Host session was lost; created a fresh terminal session (${attempt.count}/${attempt.maxAttempts}).`;
    } catch (error) {
      if (error instanceof TerminalRebuildLimitError) {
        await terminalSessionManager.updateRuntimeMetadata(session.id, { runtimeKind: "pty", ptyHost: session.ptyHost, recoverable: false });
        terminalSessionManager.markExited(session.id, 1);
      }
      throw error;
    }
  } else {
    await terminalSessionManager.updateSessionLaunch(session.id, resolveDefaultTerminalLaunchConfig());
    await terminalSessionManager.updateSessionMetadata(session.id, { cwd: session.cwd, activeCommand: null });
    terminalSessionManager.markRunning(session.id);
  }
  // Resolve provider-specific targets before launching anything (Pi requires a
  // session file); never guess a provider or select the latest thread in a cwd.
  const sessionFile = thread ? await getAgentAdapter(thread.provider).resolveResumeTarget(thread.threadId, session.pi) : undefined;
  const runtime = await launchHostedTerminal(options, true);
  try {
    if (thread) {
      const command = buildAgentResumeCommand({ ...thread, sessionFile, shell: session.command });
      await runtime.hosted!.writeSteps([{ type: "text", data: command.replace(/\n$/, "") }, { type: "delay", ms: 200 }, { type: "text", data: "\r" }], `recovery:${session.ptyHost!.sessionInstanceId}`);
      await terminalSessionManager.updateSessionThreadId(session.id, thread.threadId, thread.provider);
    }
  } catch (error) {
    // The shell still belongs to Host. Detach without killing it or replaying an
    // uncertain resume; the saved binding lets a later connection inspect it.
    runtime.dispose();
    throw error;
  }
  logger.warn("terminal.pty-host.session-missing.rebuild", { terminalSessionId: session.id, warning });
  return { runtime, warning };
}

export async function reconcileHostedTerminals(manager: TerminalSessionManager, registry: TerminalRuntimeRegistry): Promise<void> {
  if (!usesPtyHost()) return;
  for (const session of manager.listSessions()) {
    if (session.runtimeKind !== "pty" || session.status !== "running") continue;
    if (!session.ptyHost) { manager.markExited(session.id); continue; }
    try { await ensureHostedTerminal({ session, terminalSessionManager: manager, runtimeRegistry: registry }); }
    catch (error) {
      logger.warn("terminal.pty-host.reconcile.failed", { terminalSessionId: session.id, error });
    }
  }
}
