import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type {
  AgentTeamFrameworkRepairRecoveryStatus,
  AgentTeamFrameworkRepairResponse,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import {
  getAgentTeamFrameworkRepair,
  getAgentTeamRunForTerminal,
} from "../../../services/terminal/index";
import {
  AGENT_TEAM_POLL_INTERVAL_MS,
  isAgentTeamRunActive,
  type WorkerDraft,
} from "./panel-model";
import { useAgentTeamModelConfigError } from "./model-error";
import { useAgentTeamScopeGuard } from "./scope";

function useAgentTeamWorkerDrafts() {
  const [workerDrafts, setWorkerDrafts] = useState<WorkerDraft[] | null>(null);
  const workerDraftDirtyRef = useRef(false);
  const workerDraftSourceRef = useRef<string | null>(null);

  const syncFromRun = useMemoizedFn(
    (next: AgentTeamRun | null, options?: { force?: boolean }): void => {
      if (next?.phase !== "proposal" || !next.proposal) {
        workerDraftDirtyRef.current = false;
        workerDraftSourceRef.current = null;
        setWorkerDrafts(null);
        return;
      }
      if (
        !options?.force &&
        workerDraftSourceRef.current !== null &&
        workerDraftDirtyRef.current
      ) {
        return;
      }
      workerDraftDirtyRef.current = false;
      workerDraftSourceRef.current = `${next.runId}:${next.updatedAt}`;
      setWorkerDrafts(
        next.proposal.workers.map((worker) => ({
          role: worker.role,
          intent: worker.intent,
        })),
      );
    },
  );

  const update = useMemoizedFn((drafts: WorkerDraft[]): void => {
    workerDraftDirtyRef.current = true;
    setWorkerDrafts(drafts);
  });

  return { syncFromRun, update, workerDrafts };
}

interface UseAgentTeamRunControllerOptions {
  apiBase: string;
  onActiveRunChange?: (active: boolean) => void;
  onAuthExpired?: () => void;
  projectId: string | null;
  terminalSessionId: string | null;
  token: string;
}

export function useAgentTeamRunController({
  apiBase,
  onActiveRunChange,
  onAuthExpired,
  projectId,
  terminalSessionId,
  token,
}: UseAgentTeamRunControllerOptions) {
  const [run, setRun] = useState<AgentTeamRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frameworkRecovery, setFrameworkRecovery] =
    useState<AgentTeamFrameworkRepairRecoveryStatus | null>(null);
  const drafts = useAgentTeamWorkerDrafts();
  const {
    message: error,
    details: modelConfigError,
    setMessage: setError,
    handle: handleError,
    clear: clearError,
  } = useAgentTeamModelConfigError(onAuthExpired);

  const syncActiveRunPresence = useMemoizedFn((next: AgentTeamRun | null) => {
    onActiveRunChange?.(Boolean(next && isAgentTeamRunActive(next)));
  });
  const clearRun = useMemoizedFn(() => {
    setRun(null);
    setFrameworkRecovery(null);
    drafts.syncFromRun(null);
    syncActiveRunPresence(null);
  });
  const handleRunScopeMismatch = useMemoizedFn(() => {
    clearRun();
    setError("Agent Team 返回了不属于当前 Terminal 的 Run，已停止展示。");
  });
  const { canApplyRunToCurrentScope, isCurrentScope } = useAgentTeamScopeGuard(
    projectId,
    terminalSessionId,
    handleRunScopeMismatch,
  );

  const applyRun = useMemoizedFn(
    (
      next: AgentTeamRun,
      recovery: AgentTeamFrameworkRepairRecoveryStatus | null,
      options?: { forceDrafts?: boolean },
    ) => {
      setRun(next);
      setFrameworkRecovery(recovery);
      drafts.syncFromRun(next, { force: options?.forceDrafts });
      syncActiveRunPresence(next);
    },
  );

  const loadRun = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !terminalSessionId) {
      clearRun();
      return;
    }
    const requestedProjectId = projectId;
    const requestedTerminalSessionId = terminalSessionId;
    try {
      const next = await getAgentTeamRunForTerminal(
        apiBase,
        token,
        requestedProjectId,
        requestedTerminalSessionId,
      );
      if (
        !canApplyRunToCurrentScope(
          next,
          requestedProjectId,
          requestedTerminalSessionId,
        )
      ) {
        return;
      }
      const recovery =
        next?.frameworkRepair?.result === "blocked"
          ? await getAgentTeamFrameworkRepair(apiBase, token, next.runId)
          : null;
      if (
        !canApplyRunToCurrentScope(
          next,
          requestedProjectId,
          requestedTerminalSessionId,
        )
      ) {
        return;
      }
      if (next) {
        applyRun(next, recovery);
      } else {
        clearRun();
      }
    } catch (caught) {
      if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
        handleError(caught);
      }
    }
  });

  useEffect(() => {
    clearRun();
    clearError();
    setBusy(false);
    setLoading(false);
    if (!projectId || !terminalSessionId) {
      return;
    }
    const requestedProjectId = projectId;
    const requestedTerminalSessionId = terminalSessionId;
    setLoading(true);
    void loadRun().finally(() => {
      if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
        setLoading(false);
      }
    });
  }, [
    clearRun,
    clearError,
    isCurrentScope,
    loadRun,
    projectId,
    terminalSessionId,
  ]);

  useEffect(() => {
    if (!projectId || !terminalSessionId) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadRun();
    }, AGENT_TEAM_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadRun, projectId, terminalSessionId]);

  const runAction = useMemoizedFn(
    async (
      action: () => Promise<AgentTeamRun>,
      onApplied?: (next: AgentTeamRun) => void,
    ): Promise<void> => {
      if (!projectId || !terminalSessionId) {
        return;
      }
      const requestedProjectId = projectId;
      const requestedTerminalSessionId = terminalSessionId;
      setBusy(true);
      clearError();
      try {
        const next = await action();
        if (
          !canApplyRunToCurrentScope(
            next,
            requestedProjectId,
            requestedTerminalSessionId,
          )
        ) {
          return;
        }
        applyRun(
          next,
          next.frameworkRepair?.result === "blocked" ? frameworkRecovery : null,
          { forceDrafts: true },
        );
        onApplied?.(next);
      } catch (caught) {
        if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
          handleError(caught);
        }
      } finally {
        if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
          setBusy(false);
        }
      }
    },
  );

  const runFrameworkRepairAction = useMemoizedFn(
    async (
      action: () => Promise<AgentTeamFrameworkRepairResponse>,
    ): Promise<void> => {
      if (!projectId || !terminalSessionId) {
        return;
      }
      const requestedProjectId = projectId;
      const requestedTerminalSessionId = terminalSessionId;
      setBusy(true);
      setError(null);
      try {
        const response = await action();
        const next = response.successorRun ?? response.run;
        if (
          !canApplyRunToCurrentScope(
            next,
            requestedProjectId,
            requestedTerminalSessionId,
          )
        ) {
          return;
        }
        applyRun(
          next,
          next.frameworkRepair?.result === "blocked" ? response.recovery : null,
          { forceDrafts: true },
        );
      } catch (caught) {
        if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
          handleError(caught);
        }
      } finally {
        if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
          setBusy(false);
        }
      }
    },
  );
  const handleScopedError = useMemoizedFn(
    (
      caught: unknown,
      expectedProjectId: string,
      expectedTerminalSessionId: string,
    ) => {
      if (isCurrentScope(expectedProjectId, expectedTerminalSessionId)) {
        handleError(caught);
      }
    },
  );

  return {
    busy,
    error,
    frameworkRecovery,
    handleScopedError,
    loading,
    modelConfigError,
    run,
    runAction,
    runFrameworkRepairAction,
    setError,
    updateWorkerDrafts: drafts.update,
    workerDrafts: drafts.workerDrafts,
  };
}
