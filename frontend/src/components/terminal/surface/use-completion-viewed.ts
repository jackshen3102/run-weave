import { useEffect, useRef, type RefObject } from "react";
import { useMemoizedFn } from "ahooks";
import type { Terminal } from "@xterm/xterm";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { useTerminalSessionsQuery } from "../../../features/terminal/queries/workspace";
import { reportTerminalCompletionViewed } from "../../../services/terminal/sessions";

export function useCompletionViewed(options: {
  apiBase: string;
  token: string;
  terminalSessionId: string;
  panelId?: string;
  active: boolean;
  atBottom: boolean;
  connected: boolean;
  terminalRef: RefObject<Terminal | null>;
}) {
  const marker = useTerminalWorkspaceStore((state) => state.completionMarkers[options.terminalSessionId] ?? 0);
  const sessions = useTerminalSessionsQuery();
  const revision = Math.max(marker, sessions.data?.find((session) => session.terminalSessionId === options.terminalSessionId)?.completionRevision ?? 0);
  const reported = useRef("");
  const pending = useRef(false);
  const report = useMemoizedFn(async () => {
    if (!options.active || !options.atBottom || !options.connected || !revision || pending.current ||
      document.visibilityState !== "visible" || !document.hasFocus()) return;
    const element = options.terminalRef.current?.element;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Overlays and hidden workspace tabs must not count as reading a result.
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!top || !element.contains(top)) return;
    const key = JSON.stringify([options.apiBase, options.terminalSessionId, options.panelId, revision]);
    if (reported.current === key) return;
    pending.current = true;
    try {
      await reportTerminalCompletionViewed(options.apiBase, options.token, options.terminalSessionId, {
        completionRevision: revision, panelIds: options.panelId ? [options.panelId] : [],
      });
      reported.current = key;
    } catch {
      // Best-effort visibility signal; a failed request must not hide an alert.
    } finally { pending.current = false; }
  });
  useEffect(() => {
    if (!options.active || !options.atBottom || !options.connected || !revision) return;
    // Allow the final terminal output to render before reporting it as seen.
    const timer = window.setInterval(() => { void report(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [options.active, options.atBottom, options.connected, revision, report]);
}
