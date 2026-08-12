import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { useMemoizedFn } from "ahooks";
import { useRef, useState } from "react";
import { isSupportedFloatingComposerAgent } from "../../features/terminal/floating-composer";
import { useTerminalPromptInsertionStore } from "../../features/terminal/prompt-insertion-store";
import type { TerminalMarkdownViewMode } from "../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../features/terminal/workspace-store";
import type { TerminalPreviewLineTarget } from "./terminal-preview-file-view";

interface UseTerminalMarkdownReferenceActionsArgs {
  activeSession: TerminalSessionListItem | null;
  projectId: string | null;
  selectedFilePath?: string;
  setMarkdownViewMode: (
    projectId: string,
    mode: TerminalMarkdownViewMode,
  ) => void;
}

export function useTerminalMarkdownReferenceActions({
  activeSession,
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

  const insert = useMemoizedFn((reference: string): void => {
    if (activeSession && canInsert) {
      requestPromptInsertion(activeSession.terminalSessionId, ` ${reference} `);
    }
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
    disabledReason,
    insert,
    lineTarget,
    revealSourceLine,
    setTarget,
  };
}
