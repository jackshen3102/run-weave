import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import headless from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import type { TerminalAgentSettingsProvider } from "@runweave/shared/terminal/agent-settings";
import { resolvePanelTarget } from "../application/panel-targets";
import type { TerminalPanelRecord, TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import { getAgentForCommand } from "../state/terminal-state-service";
import type { TmuxKeySequenceItem, TmuxService } from "../tmux/service";
import type { TerminalScreenSnapshot } from "./output-screen";
import type { TerminalRuntimeRegistry } from "./registry";

const exec = promisify(execFile);
const psOptions = { env: { TZ: "UTC", LC_ALL: "C" }, timeout: 1_000 };

export class TerminalAgentSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type TerminalAgentTarget = {
  session: TerminalSessionRecord;
  cwd: string;
  terminal: {
    cancelCopyMode?(): Promise<unknown>;
    capture(): Promise<string>;
    send(sequence: TmuxKeySequenceItem[]): Promise<void>;
  };
  panelId: string | null;
  threadId: string | null;
  provider: TerminalAgentSettingsProvider;
  instance: string;
  validate(): Promise<void>;
  isRunning(): boolean;
};

export function fail(status: number, code: string, message: string): never {
  throw new TerminalAgentSettingsError(status, code, message);
}

function normalizeProvider(value: string | null | undefined): TerminalAgentSettingsProvider | null {
  if (value === "codex" || value === "agy") return value;
  if (value === "trae" || value === "traex" || value === "traecli") return "traex";
  return null;
}

function settingsChanged(): never {
  fail(409, "settings_changed", "当前 Agent 会话已切换，请刷新设置");
}

function unavailable(): never {
  fail(409, "agent_settings_unavailable", "当前终端没有可设置的 Codex、TraeX 或 AGY 会话");
}

async function readForegroundAgent(panePid: number) {
  if (!Number.isSafeInteger(panePid) || panePid <= 0) return null;
  try {
    const { stdout } = await exec("ps", ["-p", String(panePid), "-o", "tty="], psOptions);
    const tty = stdout.trim();
    if (!tty || tty === "??" || tty === "?") return null;
    const rows = await exec("ps", ["-t", tty, "-o", "pid=,pgid=,tpgid=,lstart=,comm="], psOptions);
    const matches = rows.stdout.split("\n").flatMap(row => {
      const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/.exec(row);
      return match ? [match] : [];
    });
    if (!matches.some(match => Number(match[1]) === panePid)) return null;
    const agents = matches.filter(match => match[2] === match[3] && getAgentForCommand(path.basename(match[5]!)));
    if (agents.length !== 1) return null;
    const [, pid, , , start, command] = agents[0]!;
    const provider = normalizeProvider(getAgentForCommand(path.basename(command!)));
    const startedAt = Date.parse(`${start} UTC`);
    return provider && Number.isFinite(startedAt) ? { provider, startedAt, instance: `${pid}:${startedAt}` } : null;
  } catch {
    return null;
  }
}

function matchingThread(
  owner: TerminalSessionRecord | TerminalPanelRecord,
  provider: TerminalAgentSettingsProvider,
  startedAt?: number,
): string | null {
  if (startedAt !== undefined && (owner.lastThreadUpdatedAt?.getTime() ?? 0) < startedAt) return null;
  if (normalizeProvider(owner.threadProvider) === provider && owner.threadId?.trim()) return owner.threadId.trim();
  if (owner.lastThreadStatus === "idle" && normalizeProvider(owner.lastThreadProvider) === provider) {
    return owner.lastThreadId?.trim() || null;
  }
  return null;
}

async function visibleHostedScreen(snapshot: TerminalScreenSnapshot): Promise<string> {
  const screen = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 0, allowProposedApi: true });
  try {
    screen.loadAddon(new unicode11.Unicode11Addon());
    screen.unicode.activeVersion = "11";
    await new Promise<void>(resolve => screen.write(snapshot.data, resolve));
    const buffer = screen.buffer.active;
    return Array.from({ length: screen.rows }, (_, row) =>
      buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").join("\n");
  } finally { screen.dispose(); }
}

async function resolveHostedTarget(
  manager: TerminalSessionManager, session: TerminalSessionRecord, runtimeRegistry?: TerminalRuntimeRegistry,
): Promise<TerminalAgentTarget> {
  const runtime = runtimeRegistry?.getSessionRuntime(session.id);
  const hosted = runtime?.hosted;
  if (!runtime || !hosted) unavailable();
  const readIdentity = async () => {
    if (process.platform !== "win32") return readForegroundAgent(runtime.pid);
    const provider = normalizeProvider(session.terminalState?.agent);
    const binding = session.ptyHost;
    if (!provider || provider === "agy" || !binding || !matchingThread(session, provider)) return null;
    return { provider, instance: binding.sessionInstanceId, startedAt: undefined };
  };
  const live = await readIdentity();
  if (!live) unavailable();
  const { provider, instance, startedAt } = live;
  const threadId = matchingThread(session, provider, startedAt);
  const validate = async () => {
    const next = await readIdentity();
    if (manager.getSession(session.id) !== session || session.status !== "running" ||
      runtimeRegistry?.getSessionRuntime(session.id) !== runtime || next?.instance !== instance ||
      next.provider !== provider || matchingThread(session, provider, startedAt) !== threadId) settingsChanged();
  };
  const keys: Record<string, string> = { Enter: "\r", Escape: "\x1b", Up: "\x1b[A", Down: "\x1b[B" };
  return { session, cwd: session.cwd, panelId: null, threadId, provider, instance, validate,
    isRunning: () => session.terminalState?.state === "agent_running", terminal: {
      capture: async () => visibleHostedScreen(await hosted.snapshot()),
      send: async (sequence) => {
        await validate();
        await hosted.writeSteps(sequence.flatMap(item => {
          const data = item.type === "literal" ? item.value : keys[item.key] ??
            (/^(?:[1-9]|s)$/.test(item.key) ? item.key : fail(400, "invalid_request", "不支持的模型菜单按键"));
          return [{ type: "text" as const, data },
            ...(item.delayAfterMs ? [{ type: "delay" as const, ms: item.delayAfterMs }] : [])];
        }));
      },
    },
  };
}

export async function resolveTerminalAgentTarget(
  manager: TerminalSessionManager, tmux: TmuxService, session: TerminalSessionRecord,
  panelId?: string, runtimeRegistry?: TerminalRuntimeRegistry,
): Promise<TerminalAgentTarget> {
  if (session.status !== "running") unavailable();
  if (session.runtimeKind === "pty" && !panelId) return resolveHostedTarget(manager, session, runtimeRegistry);
  if (session.runtimeKind !== "tmux") unavailable();
  const { panel, paneTarget } = await resolvePanelTarget(
    manager, session, { tmuxService: tmux }, panelId ? { panelId } : {}, "explicit-or-active",
  );
  if (panel.status !== "running") unavailable();
  const readIdentity = async () => readForegroundAgent(await tmux.readPaneProcessId(paneTarget));
  const live = await readIdentity();
  if (!live) unavailable();
  const { provider, instance, startedAt } = live;
  const currentThread = () => {
    const current = manager.getPanel(panel.id);
    return (current ? matchingThread(current, provider, startedAt) : null) ??
      (manager.listPanels(session.id).length === 1 ? matchingThread(session, provider, startedAt) : null);
  };
  const threadId = currentThread();
  const validate = async () => {
    const [next, selected] = await Promise.all([readIdentity(), tmux.readSelectedPane(paneTarget)]);
    if (manager.getSession(session.id) !== session || session.status !== "running" ||
      manager.getPanel(panel.id)?.status !== "running" || selected !== paneTarget.paneId ||
      next?.instance !== instance || next.provider !== provider || currentThread() !== threadId) settingsChanged();
  };
  return { session, cwd: panel.cwd, panelId: panel.id, provider, threadId, instance, validate,
    isRunning: () => manager.getPanel(panel.id)?.terminalState?.state === "agent_running", terminal: {
      cancelCopyMode: () => tmux.cancelCopyMode(paneTarget, { strict: true }),
      capture: async () => (await tmux.capturePane(paneTarget, 0)).data,
      send: async (sequence) => {
        await validate();
        await tmux.sendKeySequence(paneTarget, sequence);
      },
    },
  };
}
