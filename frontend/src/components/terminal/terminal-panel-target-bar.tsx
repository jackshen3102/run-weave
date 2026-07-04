import { useMemo, useState } from "react";
import type { TerminalPanelWorkspace, TerminalSessionListItem } from "@runweave/shared";
import { PanelBottom, PanelRight, X } from "lucide-react";
import { Button } from "../ui/button";
import {
  closeTerminalPanel,
  createTerminalPanel,
  focusTerminalPanel,
} from "../../services/terminal";

function getWorkspacePanels(
  workspace: TerminalPanelWorkspace | null,
): TerminalPanelWorkspace["panels"] {
  return Array.isArray(workspace?.panels) ? workspace.panels : [];
}

interface TerminalPanelTargetBarProps {
  apiBase: string;
  token: string;
  activeSession: TerminalSessionListItem;
  workspace: TerminalPanelWorkspace | null;
  onWorkspaceChange: (workspace: TerminalPanelWorkspace) => void;
}

function formatPanelLabel(
  panel: TerminalPanelWorkspace["panels"][number],
): string {
  return panel.alias || panel.role || panel.panelId.slice(0, 8);
}

function resolveNextPanelAlias(workspace: TerminalPanelWorkspace | null): string | null {
  if (!workspace) {
    return "tests";
  }
  const panels = getWorkspacePanels(workspace);
  const aliases = new Set(
    panels
      .map((panel) => panel.alias)
      .filter((alias): alias is string => Boolean(alias)),
  );
  if (!aliases.has("tests")) {
    return "tests";
  }
  const nextIndex = panels.length + 1;
  return `panel-${nextIndex}`;
}

export function TerminalPanelTargetBar({
  apiBase,
  token,
  activeSession,
  workspace,
  onWorkspaceChange,
}: TerminalPanelTargetBarProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panels = getWorkspacePanels(workspace);
  const activePanelId = workspace?.activePanelId ?? null;
  const activePanel = useMemo(
    () =>
      panels.find((panel) => panel.panelId === activePanelId) ??
      panels.find((panel) => panel.focused) ??
      panels[0] ??
      null,
    [activePanelId, panels],
  );
  const disabled =
    activeSession.status !== "running" || pendingAction !== null || !workspace;

  const runAction = async (
    actionName: string,
    action: () => Promise<TerminalPanelWorkspace>,
  ): Promise<void> => {
    setPendingAction(actionName);
    setError(null);
    try {
      onWorkspaceChange(await action());
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : String(actionError),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const split = (direction: "right" | "down"): void => {
    const alias = resolveNextPanelAlias(workspace);
    void runAction(`split-${direction}`, () =>
      createTerminalPanel(apiBase, token, activeSession.terminalSessionId, {
        sourcePanelId: activePanel?.panelId,
        direction,
        alias,
        role: direction === "right" && alias === "tests" ? "tests" : null,
      }),
    );
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950 px-2 text-xs text-slate-300">
      <div className="min-w-0 shrink-0 text-slate-500">
        {activeSession.cwd.split("/").filter(Boolean).at(-1) || "terminal"}
        <span className="px-1 text-slate-700">/</span>
        <span className="text-slate-200">
          {activePanel ? formatPanelLabel(activePanel) : "main"}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {panels.map((panel) => {
          const active = panel.panelId === activePanelId;
          return (
            <button
              key={panel.panelId}
              type="button"
              className={[
                "inline-flex h-6 max-w-36 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
                active
                  ? "border-sky-500/70 bg-sky-500/15 text-sky-100"
                  : "border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700 hover:text-slate-100",
              ].join(" ")}
              disabled={pendingAction !== null}
              title={panel.tmuxPaneId ?? panel.panelId}
              onClick={() => {
                void runAction("focus", () =>
                  focusTerminalPanel(
                    apiBase,
                    token,
                    activeSession.terminalSessionId,
                    panel.panelId,
                  ),
                );
              }}
            >
              <span className="truncate">{formatPanelLabel(panel)}</span>
              <span className="shrink-0 text-slate-500">
                {panel.status === "running" ? "" : "exited"}
              </span>
            </button>
          );
        })}
      </div>
      {error ? <span className="max-w-56 truncate text-rose-300">{error}</span> : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label="Split terminal right"
        title="Split terminal right"
        className="h-6 w-7 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
        onClick={() => split("right")}
      >
        <PanelRight className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label="Split terminal down"
        title="Split terminal down"
        className="h-6 w-7 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
        onClick={() => split("down")}
      >
        <PanelBottom className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !activePanel || panels.length <= 1}
        aria-label="Close terminal panel"
        title="Close terminal panel"
        className="h-6 w-7 rounded-md px-0 text-slate-300 hover:bg-rose-950/50 hover:text-rose-200"
        onClick={() => {
          if (!activePanel) {
            return;
          }
          void runAction("close", () =>
            closeTerminalPanel(
              apiBase,
              token,
              activeSession.terminalSessionId,
              activePanel.panelId,
            ),
          );
        }}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
