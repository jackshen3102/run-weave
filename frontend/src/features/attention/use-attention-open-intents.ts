import { useEffect } from "react";
import type { AttentionOpenResult } from "@runweave/shared/attention";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import {
  focusTerminalPanel,
  listTerminalSessions,
  updateTerminalSession,
} from "../../services/terminal";
import { useTerminalPreviewStore } from "../terminal/preview-store";
import { useTerminalWorkspaceStore } from "../terminal/workspace-store";

interface UseAttentionOpenIntentsOptions {
  activeConnectionId: string | null;
  apiBase: string;
  enabled: boolean;
  token: string | null;
}

function waitForTerminalSessionSelection(
  terminalSessionId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const expectedPath = `/terminal/${encodeURIComponent(terminalSessionId)}`;
  const parentProjectId = resolveTerminalParentProjectId(projectId);
  return new Promise((resolve) => {
    let settled = false;
    let stableSince: number | null = null;
    const finish = (selected: boolean) => {
      if (settled) return;
      settled = true;
      window.clearInterval(stabilityTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(selected);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    const stabilityTimer = window.setInterval(() => {
      const state = useTerminalWorkspaceStore.getState();
      const matchesTarget =
        window.location.pathname === expectedPath &&
        state.activeParentProjectId === parentProjectId &&
        state.activeProjectId === projectId &&
        state.activeSessionId === terminalSessionId;
      if (!matchesTarget) {
        stableSince = null;
        return;
      }
      stableSince ??= performance.now();
      if (performance.now() - stableSince >= 100) {
        finish(true);
      }
    }, 25);
    if (signal.aborted) finish(false);
  });
}

export function useAttentionOpenIntents({
  activeConnectionId,
  apiBase,
  enabled,
  token,
}: UseAttentionOpenIntentsOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const inFlight = new Map<string, AbortController>();
    const unsubscribeCancelled = window.electronAPI?.onAttentionOpenCancelled?.(
      (requestId) => inFlight.get(requestId)?.abort(),
    );
    const unsubscribeIntent = window.electronAPI?.onAttentionOpenIntent?.(
      (intent) => {
        const controller = new AbortController();
        const signal = controller.signal;
        inFlight.set(intent.requestId, controller);
        const deadlineTimer = window.setTimeout(
          () => controller.abort(),
          Math.max(0, intent.deadlineAt - Date.now()),
        );
        let completionOpenResolved = false;
        void (async () => {
          const report = async (result: AttentionOpenResult): Promise<void> => {
            if (signal.aborted) return;
            await window.electronAPI?.reportAttentionOpenResult?.(result);
          };
          if (
            !activeConnectionId ||
            intent.connectionId !== activeConnectionId ||
            !token
          ) {
            await report({
              requestId: intent.requestId,
              status: "connection_unavailable",
              message: "Connection changed before Slot opened",
            });
            return;
          }
          const sessions = await listTerminalSessions(
            apiBase,
            token,
            signal,
          ).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return [];
          });
          const targetSession = sessions.find(
            (session) => session.terminalSessionId === intent.terminalSessionId,
          );
          if (!targetSession) {
            await report({
              requestId: intent.requestId,
              status: "session_not_found",
              message: "Terminal Session no longer exists",
            });
            return;
          }
          useTerminalWorkspaceStore
            .getState()
            .selectProjectContext(
              resolveTerminalParentProjectId(targetSession.projectId),
              targetSession.projectId,
              intent.terminalSessionId,
            );
          window.history.pushState(
            null,
            "",
            `/terminal/${encodeURIComponent(intent.terminalSessionId)}`,
          );
          window.dispatchEvent(new PopStateEvent("popstate"));
          if (
            !(await waitForTerminalSessionSelection(
              intent.terminalSessionId,
              targetSession.projectId,
              signal,
            ))
          ) {
            return;
          }
          signal.throwIfAborted();
          let panelFallback = false;
          if (intent.panelId) {
            panelFallback = await focusTerminalPanel(
              apiBase,
              token,
              intent.terminalSessionId,
              intent.panelId,
              signal,
            )
              .then(() => false)
              .catch((error: unknown) => {
                if (signal.aborted) throw error;
                return true;
              });
          }
          signal.throwIfAborted();
          if (intent.targetSurface === "agent-team") {
            await updateTerminalSession(
              apiBase,
              token,
              intent.terminalSessionId,
              { panelSplitEnabled: true },
              signal,
            );
            signal.throwIfAborted();
            useTerminalPreviewStore.getState().openAgentTeam();
          }
          signal.throwIfAborted();
          const openedResult: AttentionOpenResult = panelFallback
            ? {
                requestId: intent.requestId,
                status: "opened_with_panel_fallback",
                message: "Session opened; original Panel is unavailable",
              }
            : { requestId: intent.requestId, status: "opened" };
          if (intent.completionRevision !== null) {
            completionOpenResolved =
              (await window.electronAPI?.authorizeAttentionCompletion?.(
                openedResult,
              )) === true;
            if (!completionOpenResolved) return;
            await updateTerminalSession(
              apiBase,
              token,
              intent.terminalSessionId,
              {
                acknowledgedCompletionRevision: intent.completionRevision,
              },
              signal,
            );
            return;
          }
          signal.throwIfAborted();
          await report(openedResult);
        })()
          .catch(async (error: unknown) => {
            if (completionOpenResolved || signal.aborted) return;
            await window.electronAPI?.reportAttentionOpenResult?.({
              requestId: intent.requestId,
              status: "session_not_found",
              message:
                error instanceof Error ? error.message : "Slot open failed",
            });
          })
          .finally(() => {
            window.clearTimeout(deadlineTimer);
            if (inFlight.get(intent.requestId) === controller) {
              inFlight.delete(intent.requestId);
            }
          });
      },
    );
    return () => {
      unsubscribeIntent?.();
      unsubscribeCancelled?.();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, [activeConnectionId, apiBase, enabled, token]);
}
