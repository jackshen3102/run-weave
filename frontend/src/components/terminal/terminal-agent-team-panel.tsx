import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  AgentTeamRun,
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
import {
  completeAgentTeamRun,
  focusAgentTeamPane,
  getAgentTeamRunForTerminal,
  recordAgentTeamRound,
  resumeAgentTeamRun,
  startAgentTeamRun,
  submitAgentTeamSplitGate,
} from "../../services/terminal";
import { HttpError } from "../../services/http";
import {
  AGENT_TEAM_POLL_INTERVAL_MS,
  PHASE_LABEL,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";
import {
  ExecutingSection,
  PlanReviewSection,
  ProposalSection,
  StartFlowSection,
} from "./terminal-agent-team-panel-sections";

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
  const [planFile, setPlanFile] = useState("");
  const [workerDrafts, setWorkerDrafts] = useState<WorkerDraft[] | null>(null);
  const [resumeNote, setResumeNote] = useState("");

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
      setRun(next);
      syncWorkerDraftsFromRun(next);
      syncActiveRunPresence(next);
    } catch (caught) {
      handleError(caught);
    }
  });

  useEffect(() => {
    setRun(null);
    setError(null);
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
        syncWorkerDraftsFromRun(next, { force: true });
        syncActiveRunPresence(next);
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
  );

  const startFlow = useMemoizedFn((): void => {
    if (!projectId || !terminalSessionId) {
      return;
    }
    const trimmedTask = task.trim();
    const trimmedPlanFile = planFile.trim();
    if (!trimmedTask) {
      setError("请先填写 Agent Team 要执行的任务。");
      return;
    }
    void runAction(() =>
      startAgentTeamRun(apiBase, token, {
        projectId,
        terminalSessionId,
        task: trimmedTask,
        ...(trimmedPlanFile ? { planFile: trimmedPlanFile } : {}),
        options: { autoApproveSplit: true },
      }).then((next) => {
        if (next.phase === "executing") {
          onPanelSplitEnabledChange?.(true);
        }
        return next;
      }),
    );
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

  const recordRound = useMemoizedFn((hadProgress: boolean): void => {
    if (!run) {
      return;
    }
    void runAction(() =>
      recordAgentTeamRound(apiBase, token, run.runId, {
        hadDiff: hadProgress,
        expectedRound: run.loop.round,
      }),
    );
  });

  const resume = useMemoizedFn((): void => {
    if (!run || !resumeNote.trim()) {
      return;
    }
    const note = resumeNote.trim();
    void runAction(() =>
      resumeAgentTeamRun(apiBase, token, run.runId, { note }),
    ).then(() => setResumeNote(""));
  });

  const complete = useMemoizedFn((): void => {
    if (!run) {
      return;
    }
    const note = resumeNote.trim();
    void runAction(() =>
      completeAgentTeamRun(apiBase, token, run.runId, note ? { note } : {}),
    ).then(() => setResumeNote(""));
  });

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
              run.status === "need_human"
                ? "bg-amber-500/20 text-amber-300"
                : run.status === "running"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-slate-700 text-slate-300",
            ].join(" ")}
          >
            {run.status === "done"
              ? "已完成"
              : run.status === "failed"
                ? "失败"
                : PHASE_LABEL[run.phase]}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mx-3 mt-2 rounded border border-rose-800 bg-rose-950/50 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : !run ? (
          <StartFlowSection
            task={task}
            planFile={planFile}
            busy={busy}
            onTaskChange={setTask}
            onPlanFileChange={setPlanFile}
            onStart={startFlow}
          />
        ) : run.phase === "plan_review" ? (
          <PlanReviewSection
            run={run}
            busy={busy}
            resumeNote={resumeNote}
            onResumeNoteChange={setResumeNote}
            onResume={resume}
            onFocusPane={focusPane}
          />
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
            run={run}
            busy={busy}
            resumeNote={resumeNote}
            onResumeNoteChange={setResumeNote}
            onRecordRound={recordRound}
            onResume={resume}
            onComplete={complete}
            onFocusPane={focusPane}
          />
        ) : null}
      </div>
    </div>
  );
}
