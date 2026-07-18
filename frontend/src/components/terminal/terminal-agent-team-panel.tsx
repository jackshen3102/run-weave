import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
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
  getAgentTeamStatusPresentation,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";
import { AgentTeamAttentionSummary } from "./terminal-agent-team-panel-attention";
import { AgentTeamFindingDecisionCard } from "./terminal-agent-team-finding-decision";
import {
  FailedRunSection,
  ProposalSection,
  StartFlowSection,
} from "./terminal-agent-team-panel-sections";
import { ExecutingSection } from "./terminal-agent-team-executing-section";

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
    onActiveRunChange?.(
      Boolean(next && next.status !== "done" && next.status !== "failed"),
    );
  });

  const loadRun = useMemoizedFn(async (): Promise<void> => {
    if (!projectId || !terminalSessionId) {
      setRun(null);
      syncWorkerDraftsFromRun(null);
      syncActiveRunPresence(null);
      return;
    }
    try {
      const next = await getAgentTeamRunForTerminal(
        apiBase,
        token,
        projectId,
        terminalSessionId,
      );
      const nextFrameworkRecovery =
        next?.frameworkRepair?.result === "blocked"
          ? await getAgentTeamFrameworkRepair(apiBase, token, next.runId)
          : null;
      setRun(next);
      setFrameworkRecovery(nextFrameworkRecovery);
      syncWorkerDraftsFromRun(next);
      syncActiveRunPresence(next);
    } catch (caught) {
      handleError(caught);
    }
  });

  useEffect(() => {
    setRun(null);
    setError(null);
    setRetryingRunId(null);
    setFrameworkRecovery(null);
    syncWorkerDraftsFromRun(null);
    syncActiveRunPresence(null);
    if (!projectId || !terminalSessionId) {
      return;
    }
    setLoading(true);
    void loadRun().finally(() => setLoading(false));
  }, [
    projectId,
    terminalSessionId,
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
    async (action: () => Promise<AgentTeamRun>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const next = await action();
        setRun(next);
        if (next.frameworkRepair?.result !== "blocked") {
          setFrameworkRecovery(null);
        }
        syncWorkerDraftsFromRun(next, { force: true });
        syncActiveRunPresence(next);
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
  );

  const runFrameworkRepairAction = useMemoizedFn(
    async (
      action: () => Promise<AgentTeamFrameworkRepairResponse>,
    ): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const response = await action();
        const next = response.successorRun ?? response.run;
        setRun(next);
        setFrameworkRecovery(
          next.frameworkRepair?.result === "blocked" ? response.recovery : null,
        );
        syncWorkerDraftsFromRun(next, { force: true });
        syncActiveRunPresence(next);
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
  );

  const continueFrameworkRepair = useMemoizedFn((): void => {
    if (!run || run.frameworkRepair?.result !== "blocked") {
      return;
    }
    void runFrameworkRepairAction(() =>
      continueAgentTeamFrameworkRepair(apiBase, token, run.runId),
    );
  });

  const rerunFrameworkRepair = useMemoizedFn((): void => {
    if (!run || run.frameworkRepair?.result !== "blocked") {
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
    void runAction(() =>
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
      }).then((next) => {
        setRetryingRunId(null);
        if (next.phase === "executing") {
          onPanelSplitEnabledChange?.(true);
        }
        return next;
      }),
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
    void runAction(() =>
      submitAgentTeamSplitGate(apiBase, token, run.runId, {
        verdict: "confirmed",
        workers: workerDrafts,
      }).then((next) => {
        if (next.phase === "executing") {
          onPanelSplitEnabledChange?.(true);
        }
        return next;
      }),
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
      if (!run || !invariantKey) {
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

  const focusPane = useMemoizedFn((panelId: string): void => {
    if (!run) {
      return;
    }
    void focusAgentTeamPane(apiBase, token, run.runId, panelId).catch(
      handleError,
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
  const statusPresentation = run
    ? getAgentTeamStatusPresentation(run, attention)
    : null;

  if (!projectId || !terminalSessionId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-slate-500">
        选择一个终端以查看 Agent Team 流程。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-slate-200">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-medium text-slate-300">Agent Team</span>
        {run ? (
          <span
            className={[
              "rounded px-1.5 py-0.5 text-[10px] uppercase",
              statusPresentation?.tone === "danger"
                ? "bg-rose-500/20 text-rose-300"
                : statusPresentation?.tone === "warning"
                  ? "bg-amber-500/20 text-amber-300"
                  : statusPresentation?.tone === "running"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-slate-700 text-slate-300",
            ].join(" ")}
          >
            {statusPresentation?.label}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mx-3 mt-2 rounded border border-rose-800 bg-rose-950/50 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </div>
      ) : null}

      {run?.pendingFindingDecision ? (
        <AgentTeamFindingDecisionCard
          key={run.pendingFindingDecision.id}
          run={run}
          busy={busy}
          onDecide={decideFinding}
        />
      ) : run && attention && run.frameworkRepair?.result !== "blocked" ? (
        <AgentTeamAttentionSummary
          attention={attention}
          onFocusPane={focusPane}
          onShowDetails={showAttentionDetails}
        />
      ) : null}

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

function normalizeOptionalPath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
