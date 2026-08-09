import { useMemoizedFn } from "ahooks";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  AgentTeamAcceptanceDisposition,
  AgentTeamFindingDisposition,
  AgentTeamFlow,
} from "@runweave/shared/agent-team";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import {
  continueAgentTeamFrameworkRepair,
  decideAgentTeamAcceptance,
  decideAgentTeamFinding,
  focusAgentTeamPane,
  rerunAgentTeamFrameworkRepair,
  startAgentTeamRun,
  submitAgentTeamSplitGate,
} from "../../services/terminal";
import {
  getAgentTeamAttention,
  getAgentTeamCaseElementId,
  getAgentTeamControlState,
  getAgentTeamStatusPresentation,
  normalizeOptionalPath,
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
import { AgentTeamModelErrorNotice } from "./terminal-agent-team-model-error";
import { useAgentTeamRunController } from "./use-agent-team-run-controller";

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
  const [task, setTask] = useState("");
  const [planFilePath, setPlanFilePath] = useState("");
  const [testCaseFilePath, setTestCaseFilePath] = useState("");
  const [reviewCheckpointEnabled, setReviewCheckpointEnabled] = useState(false);
  const [notifyMainOnHumanGate, setNotifyMainOnHumanGate] = useState(true);
  const [flow, setFlow] = useState<AgentTeamFlow>("code_first");
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  const projectId = activeProject?.projectId ?? null;
  const terminalSessionId = activeSession?.terminalSessionId ?? null;
  const {
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
    updateWorkerDrafts,
    workerDrafts,
  } = useAgentTeamRunController({
    apiBase,
    onActiveRunChange,
    onAuthExpired,
    projectId,
    terminalSessionId,
    token,
  });

  useEffect(() => {
    setRetryingRunId(null);
  }, [projectId, terminalSessionId]);

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
          retryOfRunId: retryingRunId ?? undefined,
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
      (caught) =>
        handleScopedError(
          caught,
          requestedProjectId,
          requestedTerminalSessionId,
        ),
    );
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

      <AgentTeamModelErrorNotice message={error} details={modelConfigError} />

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
