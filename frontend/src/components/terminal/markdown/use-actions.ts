import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { useMemoizedFn } from "ahooks";
import { useRef, useState } from "react";
import { isSupportedFloatingComposerAgent } from "../../../features/terminal/input/floating-composer";
import { type InsertReviewFeedback, useTerminalPromptInsertionStore } from "../../../features/terminal/input/prompt-store";
import type { TerminalMarkdownViewMode } from "../../../features/terminal/preview/store";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import type { TerminalPreviewLineTarget } from "../preview/files/view";

interface UseTerminalMarkdownReferenceActionsArgs {
  scope: string;
  activeSession: TerminalSessionListItem | null;
  activePanelId: string | null;
  projectId: string | null;
  selectedFilePath?: string;
  setMarkdownViewMode: (
    projectId: string,
    mode: TerminalMarkdownViewMode,
  ) => void;
}

export function useTerminalMarkdownReferenceActions({
  scope,
  activeSession,
  activePanelId,
  projectId,
  selectedFilePath,
  setMarkdownViewMode,
}: UseTerminalMarkdownReferenceActionsArgs) {
  const activeTerminalState = useTerminalWorkspaceStore((state) =>
    activeSession
      ? state.terminalStateBySessionId[activeSession.terminalSessionId]
      : undefined,
  );
  const requestPromptInsertion = useTerminalPromptInsertionStore(
    (state) => state.requestInsertion,
  );
  const panelWorkspace = useTerminalWorkspaceStore((state) => activeSession
    ? state.panelWorkspaceBySessionId[activeSession.terminalSessionId] : undefined);
  const targetPanelId = activePanelId ?? panelWorkspace?.activePanelId ?? null;
  const panel = panelWorkspace?.panels.find((item) => item.panelId === targetPanelId);
  const [lineTarget, setLineTarget] =
    useState<TerminalPreviewLineTarget | null>(null);
  const lineTargetSequenceRef = useRef(0);
  const terminalState = activeTerminalState ?? activeSession?.terminalState;
  const canInsert = Boolean(
    activeSession?.status === "running" &&
    isSupportedFloatingComposerAgent({
      activeCommand: activeSession.activeCommand,
      terminalState,
    }),
  );
  const disabledReason = !activeSession
    ? "No active terminal"
    : activeSession.status !== "running"
      ? "The active terminal is not running"
      : !canInsert
        ? "Start a supported Agent before adding a reference"
        : undefined;
  const canInsertCode = activeSession?.status === "running" && (panelWorkspace
    ? Boolean(panel?.status === "running" &&
      isSupportedFloatingComposerAgent({ activeCommand: panel.activeCommand, terminalState: panel.terminalState }) &&
      (panel.codexContext === undefined || panel.codexContext?.inputReady))
    : canInsert);

  const insert = useMemoizedFn((reference: string): void => {
    if (activeSession && canInsert) {
      requestPromptInsertion(activeSession.terminalSessionId, ` ${reference} `);
    }
  });
  const insertCode = useMemoizedFn((text: string): void => {
    if (activeSession && canInsertCode) {
      requestPromptInsertion(activeSession.terminalSessionId, text, { destination: "composer", panelId: targetPanelId });
    }
  });
  const insertReview: InsertReviewFeedback = useMemoizedFn((text, receipt) => {
    if (!activeSession || !canInsertCode) {
      receipt("target-changed");
      return () => {};
    }
    return requestPromptInsertion(activeSession.terminalSessionId, text,
      { destination: "composer", panelId: targetPanelId, scope }, receipt);
  });
  const setTarget = useMemoizedFn(
    (path: string, target?: { line: number; column: number }): void => {
      if (!target) {
        setLineTarget(null);
        return;
      }
      lineTargetSequenceRef.current += 1;
      setLineTarget({
        path,
        ...target,
        key: `${path}:${target.line}:${target.column}:${lineTargetSequenceRef.current}`,
      });
    },
  );
  const revealSourceLine = useMemoizedFn((line: number): void => {
    if (!projectId || !selectedFilePath) {
      return;
    }
    setTarget(selectedFilePath, { line, column: 1 });
    setMarkdownViewMode(projectId, "source");
  });

  return {
    canInsert,
    canInsertCode,
    targetPanelId,
    disabledReason,
    insert,
    insertCode,
    insertReview,
    lineTarget,
    revealSourceLine,
    setTarget,
  };
}
