import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamFindingDisposition,
  AgentTeamFlow,
  AgentTeamFrameworkRepairRecoveryStatus,
  AgentTeamFrameworkRepairResponse,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import {
  continueAgentTeamFrameworkRepair,
  decideAgentTeamAcceptance,
  decideAgentTeamFinding,
  focusAgentTeamPane,
  getAgentTeamFrameworkRepair,
  getAgentTeamRunForTerminal,
  rerunAgentTeamFrameworkRepair,
  startAgentTeamRun,
  submitAgentTeamSplitGate,
} from "../../services/terminal";
import { HttpError } from "../../services/http";
import {
  AGENT_TEAM_POLL_INTERVAL_MS,
  getAgentTeamAttention,
  getAgentTeamCaseElementId,
  getAgentTeamControlState,
  getAgentTeamStatusPresentation,
  isAgentTeamRunActive,
  normalizeOptionalPath,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";
import {
  AgentTeamPanelGate,
  AgentTeamPanelHeader,
  AgentTeamPanelEmptyState,
} from "./terminal-agent-team-panel-summary";
import {
  FailedRunSection,
  ProposalSection,
  StartFlowSection,
} from "./terminal-agent-team-panel-sections";
import { ExecutingSection } from "./terminal-agent-team-executing-section";
import { useAgentTeamScopeGuard } from "./terminal-agent-team-scope";

interface TerminalAgentTeamPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  onPanelSplitEnabledChange?: (enabled: boolean) => void;
  onActiveRunChange?: (active: boolean) => void;
  onAuthExpired?: () => void;
}

export function TerminalAgentTeamPanel({
  apiBase,
  token,
  activeProject,
  activeSession,
  onPanelSplitEnabledChange,
  onActiveRunChange,
  onAuthExpired,
}: TerminalAgentTeamPanelProps) {
  const [run, setRun] = useState<AgentTeamRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [planFilePath, setPlanFilePath] = useState("");
  const [testCaseFilePath, setTestCaseFilePath] = useState("");
  const [reviewCheckpointEnabled, setReviewCheckpointEnabled] = useState(false);
  const [notifyMainOnHumanGate, setNotifyMainOnHumanGate] = useState(true);
  const [flow, setFlow] = useState<AgentTeamFlow>("code_first");
  const [workerDrafts, setWorkerDrafts] = useState<WorkerDraft[] | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [frameworkRecovery, setFrameworkRecovery] =
    useState<AgentTeamFrameworkRepairRecoveryStatus | null>(null);

  const projectId = activeProject?.projectId ?? null;
  const terminalSessionId = activeSession?.terminalSessionId ?? null;
  const runIdRef = useRef<string | null>(null);
  const workerDraftDirtyRef = useRef(false);
  const workerDraftSourceRef = useRef<string | null>(null);
  runIdRef.current = run?.runId ?? null;

  const handleError = useMemoizedFn((caught: unknown): void => {
    if (caught instanceof HttpError && caught.status === 401) {
      onAuthExpired?.();
      return;
    }
    setError(caught instanceof Error ? caught.message : String(caught));
  });

  const syncWorkerDraftsFromRun = useMemoizedFn(
    (next: AgentTeamRun | null, options?: { force?: boolean }): void => {
      if (next?.phase !== "proposal" || !next.proposal) {
        workerDraftDirtyRef.current = false;
        workerDraftSourceRef.current = null;
        setWorkerDrafts(null);
        return;
      }

      const source = `${next.runId}:${next.updatedAt}`;
      if (
        !options?.force &&
        workerDraftSourceRef.current !== null &&
        workerDraftDirtyRef.current
      ) {
        return;
      }

      workerDraftDirtyRef.current = false;
      workerDraftSourceRef.current = source;
      setWorkerDrafts(
        next.proposal.workers.map((worker) => ({
          role: worker.role,
          intent: worker.intent,
        })),
      );
    },
  );

  const syncActiveRunPresence = useMemoizedFn((next: AgentTeamRun | null) => {
    onActiveRunChange?.(Boolean(next && isAgentTeamRunActive(next)));
  });

  const handleRunScopeMismatch = useMemoizedFn((): void => {
    setRun(null);
    setFrameworkRecovery(null);
    syncWorkerDraftsFromRun(null);
    syncActiveRunPresence(null);
    setError("Agent Team 返回了不属于当前 Terminal 的 Run，已停止展示。");
  });
  const { canApplyRunToCurrentScope, isCurrentScope } = useAgentTeamScopeGuard(
    projectId,
    terminalSessionId,
    handleRunScopeMismatch,
  );

  const loadRun = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !terminalSessionId) {
      setRun(null);
      syncWorkerDraftsFromRun(null);
      syncActiveRunPresence(null);
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
      const nextFrameworkRecovery =
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
      setRun(next);
      setFrameworkRecovery(nextFrameworkRecovery);
      syncWorkerDraftsFromRun(next);
      syncActiveRunPresence(next);
    } catch (caught) {
      if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
        handleError(caught);
      }
    }
  });

  useEffect(() => {
    setRun(null);
    setError(null);
    setBusy(false);
    setLoading(false);
    setRetryingRunId(null);
    setFrameworkRecovery(null);
    syncWorkerDraftsFromRun(null);
    syncActiveRunPresence(null);
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
    projectId,
    terminalSessionId,
    isCurrentScope,
    loadRun,
    syncWorkerDraftsFromRun,
    syncActiveRunPresence,
  ]);

  useEffect(() => {
    if (!projectId || !terminalSessionId) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void loadRun();
    }, AGENT_TEAM_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [projectId, terminalSessionId, loadRun]);

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
      setError(null);
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
        setRun(next);
        if (next.frameworkRepair?.result !== "blocked") {
          setFrameworkRecovery(null);
        }
        syncWorkerDraftsFromRun(next, { force: true });
        syncActiveRunPresence(next);
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
        setRun(next);
        setFrameworkRecovery(
          next.frameworkRepair?.result === "blocked" ? response.recovery : null,
        );
        syncWorkerDraftsFromRun(next, { force: true });
        syncActiveRunPresence(next);
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

  const continueFrameworkRepair = useMemoizedFn((): void => {
    if (!run || !getAgentTeamControlState(run).allowsFrameworkRecovery) {
      return;
    }
    void runFrameworkRepairAction(() =>
      continueAgentTeamFrameworkRepair(apiBase, token, run.runId),
    );
  });

  const rerunFrameworkRepair = useMemoizedFn((): void => {
    if (!run || !getAgentTeamControlState(run).allowsFrameworkRecovery) {
      return;
    }
    void runFrameworkRepairAction(() =>
      rerunAgentTeamFrameworkRepair(apiBase, token, run.runId),
    );
  });

  const startFlow = useMemoizedFn((): void => {
    if (!projectId || !terminalSessionId) {
      return;
    }
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      setError("请先填写 Agent Team 要执行的任务。");
      return;
    }
    void runAction(
      () =>
        startAgentTeamRun(apiBase, token, {
          projectId,
          terminalSessionId,
          task: trimmedTask,
          planFilePath: normalizeOptionalPath(planFilePath),
          testCaseFilePath: normalizeOptionalPath(testCaseFilePath),
          options: {
            autoApproveSplit: true,
            notifyMainOnHumanGate,
            flow,
            reviewCheckpointMode: reviewCheckpointEnabled
              ? "local_commit"
              : "disabled",
          },
        }),
      (next) => {
        setRetryingRunId(null);
        if (next.phase === "executing") {
          onPanelSplitEnabledChange?.(true);
        }
      },
    );
  });

  const retryFailedRun = useMemoizedFn((): void => {
    if (!run || run.status !== "failed") {
      return;
    }
    setTask(run.task);
    setPlanFilePath(run.verification?.planFilePath ?? "");
    setTestCaseFilePath(run.verification?.testCaseFilePath ?? "");
    setReviewCheckpointEnabled(
      run.options.reviewCheckpointMode === "local_commit",
    );
    setNotifyMainOnHumanGate(run.options.notifyMainOnHumanGate !== false);
    setFlow(run.options.flow ?? "code_first");
    setRetryingRunId(run.runId);
    setError(null);
  });

  const confirmSplit = useMemoizedFn((): void => {
    if (!run || !workerDrafts) {
      return;
    }
    void runAction(
      () =>
        submitAgentTeamSplitGate(apiBase, token, run.runId, {
          verdict: "confirmed",
          workers: workerDrafts,
        }),
      (next) => {
        if (next.phase === "executing") {
          onPanelSplitEnabledChange?.(true);
        }
      },
    );
  });

  const rejectSplit = useMemoizedFn((): void => {
    if (!run) {
      return;
    }
    void runAction(() =>
      submitAgentTeamSplitGate(apiBase, token, run.runId, {
        verdict: "rejected",
      }),
    );
  });

  const decideFinding = useMemoizedFn(
    (
      disposition: AgentTeamFindingDisposition,
      caseIds: string[],
      reason: string,
    ): void => {
      const pending = run?.pendingFindingDecision;
      const invariantKey = pending?.finding.invariantKey;
      if (
        !run ||
        !getAgentTeamControlState(run).allowsFindingDecision ||
        !invariantKey
      ) {
        return;
      }
      void runAction(() =>
        decideAgentTeamFinding(apiBase, token, run.runId, {
          invariantKey,
          disposition,
          caseIds,
          reason: reason.trim(),
        }),
      );
    },
  );

  const decideAcceptance = useMemoizedFn(
    (
      caseId: string,
      disposition: AgentTeamAcceptanceDisposition,
      reason: string,
    ): void => {
      if (!run || !getAgentTeamControlState(run).allowsAcceptanceDecision) {
        return;
      }
      void runAction(() =>
        decideAgentTeamAcceptance(apiBase, token, run.runId, {
          caseId,
          disposition,
          reason: reason.trim(),
        }),
      );
    },
  );

  const focusPane = useMemoizedFn((panelId: string): void => {
    if (!run || !projectId || !terminalSessionId) {
      return;
    }
    const requestedProjectId = projectId;
    const requestedTerminalSessionId = terminalSessionId;
    void focusAgentTeamPane(apiBase, token, run.runId, panelId).catch(
      (caught) => {
        if (isCurrentScope(requestedProjectId, requestedTerminalSessionId)) {
          handleError(caught);
        }
      },
    );
  });

  const updateWorkerDrafts = useMemoizedFn((drafts: WorkerDraft[]): void => {
    workerDraftDirtyRef.current = true;
    setWorkerDrafts(drafts);
  });

  const showAttentionDetails = useMemoizedFn((caseId: string): void => {
    if (!run) {
      return;
    }
    const element = document.getElementById(
      getAgentTeamCaseElementId(run.runId, caseId),
    );
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (element instanceof HTMLElement) {
      element.focus({ preventScroll: true });
    }
  });

  const attention =
    run?.phase === "executing" ? getAgentTeamAttention(run) : null;
  const controlState = run ? getAgentTeamControlState(run) : null;
  const statusPresentation = run
    ? getAgentTeamStatusPresentation(run, attention)
    : null;

  if (!projectId || !terminalSessionId) {
    return <AgentTeamPanelEmptyState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-slate-200">
      <AgentTeamPanelHeader
        run={run}
        projectId={projectId}
        terminalSessionId={terminalSessionId}
        loading={loading}
        statusPresentation={statusPresentation}
      />

      {error ? (
        <div className="mx-3 mt-2 rounded border border-rose-800 bg-rose-950/50 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </div>
      ) : null}

      <AgentTeamPanelGate
        run={run}
        controlState={controlState}
        attention={attention}
        busy={busy}
        onDecideFinding={decideFinding}
        onDecideAcceptance={decideAcceptance}
        onFocusPane={focusPane}
        onShowAttentionDetails={showAttentionDetails}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : run?.status === "failed" && retryingRunId === run.runId ? (
          <StartFlowSection
            mode="retry"
            task={task}
            planFilePath={planFilePath}
            testCaseFilePath={testCaseFilePath}
            reviewCheckpointEnabled={reviewCheckpointEnabled}
            notifyMainOnHumanGate={notifyMainOnHumanGate}
            flow={flow}
            busy={busy}
            onTaskChange={setTask}
            onPlanFilePathChange={setPlanFilePath}
            onTestCaseFilePathChange={setTestCaseFilePath}
            onReviewCheckpointEnabledChange={setReviewCheckpointEnabled}
            onNotifyMainOnHumanGateChange={setNotifyMainOnHumanGate}
            onFlowChange={setFlow}
            onStart={startFlow}
          />
        ) : !run ? (
          <StartFlowSection
            task={task}
            planFilePath={planFilePath}
            testCaseFilePath={testCaseFilePath}
            reviewCheckpointEnabled={reviewCheckpointEnabled}
            notifyMainOnHumanGate={notifyMainOnHumanGate}
            flow={flow}
            busy={busy}
            onTaskChange={setTask}
            onPlanFilePathChange={setPlanFilePath}
            onTestCaseFilePathChange={setTestCaseFilePath}
            onReviewCheckpointEnabledChange={setReviewCheckpointEnabled}
            onNotifyMainOnHumanGateChange={setNotifyMainOnHumanGate}
            onFlowChange={setFlow}
            onStart={startFlow}
          />
        ) : run.status === "failed" && run.phase !== "executing" ? (
          <FailedRunSection run={run} busy={busy} onRetry={retryFailedRun} />
        ) : run.phase === "proposal" && workerDrafts ? (
          <ProposalSection
            run={run}
            workerDrafts={workerDrafts}
            busy={busy}
            onChangeDrafts={updateWorkerDrafts}
            onConfirm={confirmSplit}
            onReject={rejectSplit}
          />
        ) : run.phase === "executing" ? (
          <ExecutingSection
            apiBase={apiBase}
            token={token}
            projectId={projectId}
            run={run}
            controlState={getAgentTeamControlState(run)}
            frameworkRecovery={frameworkRecovery}
            busy={busy}
            onRetry={retryFailedRun}
            onContinueFrameworkRepair={continueFrameworkRepair}
            onRerunFrameworkRepair={rerunFrameworkRepair}
            onAuthExpired={onAuthExpired}
          />
        ) : null}
      </div>
    </div>
  );
}
