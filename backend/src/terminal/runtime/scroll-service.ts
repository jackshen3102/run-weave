import type { TerminalScrollInput, TerminalScrollState } from "@runweave/shared/terminal/websocket";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService, TmuxPaneTarget } from "../tmux/service";
import type { PtyRuntime } from "./pty-service";
import { isTmuxBackedSession, resolveTmuxTarget } from "./launcher";
import { beginTerminalInput } from "./input-admission";

// All viewers serialize decisions and writes for the same pane, without owning its lifetime.
const paneWrites = new Map<string, Promise<void>>();

export function createTerminalScrollController(options: {
  manager: TerminalSessionManager; terminalId: string; tmux: TmuxService;
  runtime: PtyRuntime; alive: () => boolean; publish: (state: TerminalScrollState) => void;
}) {
  const { manager, terminalId, tmux, runtime, alive, publish } = options;
  let disposed = false;
  let running = false;
  const pending: TerminalScrollInput[] = [];
  const cancelledGestures = new Set<string>();
  let latestGestureId = "";
  let gesture: { id: string; pane: string; owner: string; applicationMode: string; sequence: number; cancelled: boolean } | undefined;
  let lastState: TerminalScrollState = { type: "scroll-state", owner: "history", copyMode: false, offsetRows: 0, status: "state" };
  const valid = () => !disposed && alive();
  const feedback = (message: TerminalScrollInput, cancelled: boolean) => {
    if (valid()) publish({ ...lastState, gestureId: message.gestureId, sequence: message.sequence,
      status: cancelled ? "cancelled" : "applied" });
  };
  const target = async () => {
    const session = manager.getSession(terminalId);
    if (!session || session.status !== "running" || !isTmuxBackedSession(session)) throw new Error("Scroll target exited");
    const base = resolveTmuxTarget(session, tmux);
    const workspace = manager.getPanelWorkspace(terminalId);
    const panel = workspace && manager.getPanel(workspace.activePanelId);
    const paneId = panel?.tmuxPaneId ?? await tmux.readSelectedPane(base);
    if (!paneId) throw new Error("Scroll pane unavailable");
    return { session, pane: { ...base, paneId } satisfies TmuxPaneTarget };
  };
  const read = async (pane: TmuxPaneTarget) => {
    const state = await tmux.readScrollState(pane);
    lastState = { type: "scroll-state", owner: state.owner, copyMode: state.copyMode,
      offsetRows: state.owner === "history" ? state.offsetRows : null, status: "state" };
    return state;
  };
  const apply = async (message: TerminalScrollInput, pane: TmuxPaneTarget) => {
    const current = await target();
    if (!valid() || current.pane.paneId !== pane.paneId) { feedback(message, true); return; }
    const state = await read(pane);
    if (!valid()) return;
    const selected = manager.getPanelWorkspace(terminalId)?.activePanelId;
    if (manager.getSession(terminalId) !== current.session || (selected && manager.getPanel(selected)?.tmuxPaneId !== pane.paneId)) { feedback(message, true); return; }
    if (cancelledGestures.has(message.gestureId) || message.gestureId !== latestGestureId) { feedback(message, true); return; }
    if (gesture?.id !== message.gestureId) {
      gesture = { id: message.gestureId, pane: pane.paneId, owner: state.owner,
        applicationMode: state.applicationMode, sequence: -1, cancelled: false };
    }
    if (gesture.pane !== pane.paneId || gesture.owner !== state.owner ||
      gesture.applicationMode !== state.applicationMode || message.sequence <= gesture.sequence) gesture.cancelled = true;
    gesture.sequence = message.sequence;
    if (gesture.cancelled) { feedback(message, true); return; }
    const release = beginTerminalInput(current.session, pane.paneId, { kind: "browse", source: "scroll" });
    try {
      if (state.owner === "application") {
        runtime.write(`\x1b[<${message.deltaSteps > 0 ? 64 : 65};${state.col};${state.row}M`.repeat(Math.abs(message.deltaSteps)));
      } else if (state.copyMode || message.deltaSteps > 0) {
        await tmux.scrollHistory(pane, message.deltaSteps);
        await read(pane);
      }
      feedback(message, false);
    } finally { release(); }
  };
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (valid() && pending.length) {
        const message = pending.shift()!;
        try {
          const { pane } = await target();
          const key = `${pane.socketPath}/${pane.paneId}`;
          const previous = paneWrites.get(key) ?? Promise.resolve();
          const write = previous.catch(() => {}).then(() => valid() ? apply(message, pane) : undefined);
          paneWrites.set(key, write);
          try { await write; } finally { if (paneWrites.get(key) === write) paneWrites.delete(key); }
        } catch { if (gesture) gesture.cancelled = true; feedback(message, true); }
      }
    } finally { running = false; }
  };
  return {
    cancel(id: string) {
      cancelledGestures.add(id);
      if (cancelledGestures.size > 16) cancelledGestures.delete([...cancelledGestures][0]!);
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]?.gestureId === id) pending.splice(i, 1);
    },
    enqueue(message: TerminalScrollInput) {
      if (!valid()) return;
      latestGestureId = message.gestureId;
      if (pending.reduce((sum, item) => sum + Math.abs(item.deltaSteps), 0) + Math.abs(message.deltaSteps) > 512) {
        pending.length = 0;
        if (gesture) gesture.cancelled = true;
        feedback(message, true);
        return;
      }
      const tail = pending.at(-1);
      if (tail && tail.gestureId === message.gestureId && tail.phase === message.phase &&
        Math.sign(tail.deltaSteps) === Math.sign(message.deltaSteps) && Math.abs(tail.deltaSteps + message.deltaSteps) <= 128) {
        tail.deltaSteps += message.deltaSteps;
        tail.sequence = message.sequence;
      } else pending.push({ ...message });
      void drain();
    },
    async sync() {
      try { const { pane } = await target(); await read(pane); if (valid()) publish(lastState); } catch { /* Exit/close owns the terminal error. */ }
    },
    dispose() { disposed = true; pending.length = 0; },
  };
}
