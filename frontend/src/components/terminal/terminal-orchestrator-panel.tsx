import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateOrchestratorRunRequest,
  HumanGatePhase,
  HumanGateVerdictValue,
  OrchestratorRoundConfirmationVerdictValue,
  OrchestratorRoleDefinition,
  OrchestratorRunPackage,
  OrchestratorRunRole,
  OrchestratorRunStatus,
  TerminalProjectListItem,
  TerminalSessionListItem,
} from "@runweave/shared";
import { RefreshCw, Workflow } from "lucide-react";
import {
  createOrchestratorRun,
  injectOrchestratorPrompt,
  listOrchestratorRoles,
  listOrchestratorRuns,
  previewOrchestratorRunPrompt,
  saveOrchestratorRoles,
  setOrchestratorRunStatus,
  submitOrchestratorHumanGate,
  submitOrchestratorRoundConfirmation,
} from "../../services/terminal";
import { HttpError } from "../../services/http";
import { Button } from "../ui/button";
import {
  DEFAULT_STARTUP_PROMPT,
  RUN_AUTO_REFRESH_INTERVAL_MS,
} from "./orchestrator/constants";
import { RunConfig } from "./orchestrator/RunConfig";
import { RunMonitor } from "./orchestrator/RunMonitor";
import { RunPromptPreviewDialog } from "./orchestrator/RunPromptPreviewDialog";
import type { AgentCliCommand, RoleDraft } from "./orchestrator/types";
import {
  normalizeAgentCliCommand,
  normalizeStartupPrompt,
} from "./orchestrator/utils";

interface TerminalOrchestratorPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  sessions: TerminalSessionListItem[];
  onAuthExpired?: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}

export function TerminalOrchestratorPanel({
  apiBase,
  token,
  activeProject,
  sessions,
  onAuthExpired,
  onSelectSession,
}: TerminalOrchestratorPanelProps) {
  const [roles, setRoles] = useState<OrchestratorRoleDefinition[]>([]);
  const [runs, setRuns] = useState<OrchestratorRunPackage[]>([]);
  const [task, setTask] = useState("");
  const [startupPrompt, setStartupPrompt] = useState(DEFAULT_STARTUP_PROMPT);
  const [orchestratorMode, setOrchestratorMode] = useState<"new" | "reuse">(
    "new",
  );
  const [orchestratorCommand, setOrchestratorCommand] =
    useState<AgentCliCommand>("codex");
  const [orchestratorSessionId, setOrchestratorSessionId] = useState("");
  const [
    requireHumanConfirmationEachRound,
    setRequireHumanConfirmationEachRound,
  ] = useState(false);
  const [autoApprovePlanGate, setAutoApprovePlanGate] = useState(false);
  const [autoApproveVerifyGate, setAutoApproveVerifyGate] = useState(false);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [roleLibraryOpen, setRoleLibraryOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<"restart" | "blank" | null>(null);
  const [promptPreview, setPromptPreview] = useState<{
    runId: string;
    prompt: string;
    payload: CreateOrchestratorRunRequest;
  } | null>(null);
  const [injectText, setInjectText] = useState("");
  const [gateReason, setGateReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRefreshInFlightRef = useRef(false);

  const projectSessions = useMemo(
    () =>
      activeProject
        ? sessions.filter(
            (session) => session.projectId === activeProject.projectId,
          )
        : [],
    [activeProject, sessions],
  );
  const activeRun = useMemo(() => {
    if (draftMode) {
      return null;
    }
    return (
      runs.find((run) =>
        ["running", "paused", "need_human"].includes(run.status),
      ) ??
      runs[0] ??
      null
    );
  }, [draftMode, runs]);

  const handleRequestError = useMemoizedFn((caught: unknown) => {
    if (caught instanceof HttpError && caught.status === 401) {
      onAuthExpired?.();
      return "Unauthorized";
    }
    return caught instanceof Error ? caught.message : String(caught);
  });

  const refresh = useMemoizedFn(async () => {
    if (!activeProject) {
      return;
    }
    setLoading(true);
    try {
      const [rolePayload, runPayload] = await Promise.all([
        listOrchestratorRoles(apiBase, token),
        listOrchestratorRuns(apiBase, token, activeProject.projectId),
      ]);
      setRoles(rolePayload.roles);
      setRuns(runPayload.runs);
      setRoleDrafts((current) => {
        const next = { ...current };
        for (const role of rolePayload.roles) {
          next[role.id] ??= {
            selected: true,
            bindingMode: "new",
            sessionId: "",
            prompt: role.prompt,
          };
        }
        return next;
      });
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const refreshRuns = useMemoizedFn(async (options?: { silent?: boolean }) => {
    if (!activeProject || runRefreshInFlightRef.current) {
      return;
    }
    runRefreshInFlightRef.current = true;
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const runPayload = await listOrchestratorRuns(
        apiBase,
        token,
        activeProject.projectId,
      );
      setRuns(runPayload.runs);
      if (!options?.silent) {
        setError(null);
      }
    } catch (caught) {
      const message = handleRequestError(caught);
      if (!options?.silent || message === "Unauthorized") {
        setError(message);
      }
    } finally {
      runRefreshInFlightRef.current = false;
      if (!options?.silent) {
        setLoading(false);
      }
    }
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeProject) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      void refreshRuns({ silent: true });
    }, RUN_AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [activeProject, refreshRuns]);

  const buildRunPayload = useMemoizedFn(
    (runId?: string): CreateOrchestratorRunRequest | null => {
      if (!activeProject || !task.trim()) {
        return null;
      }

      const selectedRoles: OrchestratorRunRole[] = roles
        .filter((role) => roleDrafts[role.id]?.selected)
        .map((role) => {
          const draft = roleDrafts[role.id];
          return {
            id: role.id,
            name: role.name,
            binding: {
              mode: draft?.bindingMode ?? "new",
              sessionId:
                draft?.bindingMode === "reuse" ? draft.sessionId : null,
            },
            terminal: {
              ...role.terminal,
              command: normalizeAgentCliCommand(role.terminal.command),
              args: [],
            },
            prompt: draft?.prompt ?? role.prompt,
            ...((draft?.skill ?? role.skill)?.trim()
              ? { skill: (draft?.skill ?? role.skill)?.trim() }
              : {}),
          };
        });

      return {
        ...(runId ? { runId } : {}),
        projectId: activeProject.projectId,
        task: task.trim(),
        orchestrator: {
          binding: {
            mode: orchestratorMode,
            sessionId:
              orchestratorMode === "reuse" ? orchestratorSessionId : null,
          },
          startupPrompt: startupPrompt.trim(),
          terminal: {
            command: orchestratorCommand,
            args: [],
            runtimePreference: "auto",
          },
        },
        roles: selectedRoles,
        options: {
          requireHumanConfirmationEachRound,
          autoApprovePlanGate,
          autoApproveVerifyGate,
        },
      };
    },
  );

  const requestStartRun = useMemoizedFn(async () => {
    const payload = buildRunPayload();
    if (!payload) {
      return;
    }
    setLoading(true);
    try {
      const preview = await previewOrchestratorRunPrompt(
        apiBase,
        token,
        payload,
      );
      setPromptPreview({
        ...preview,
        payload: {
          ...payload,
          runId: preview.runId,
        },
      });
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const startRun = useMemoizedFn(async () => {
    if (!promptPreview) {
      return;
    }
    setLoading(true);
    try {
      const run = await createOrchestratorRun(
        apiBase,
        token,
        promptPreview.payload,
      );
      setRuns((current) => [
        run,
        ...current.filter((item) => item.runId !== run.runId),
      ]);
      setTask("");
      setDraftMode(null);
      setPromptPreview(null);
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const saveRoleLibrary = useMemoizedFn(async () => {
    setLoading(true);
    try {
      const payload = await saveOrchestratorRoles(apiBase, token, roles);
      setRoles(payload.roles);
      setRoleLibraryOpen(false);
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const setStatus = useMemoizedFn(async (status: OrchestratorRunStatus) => {
    if (!activeRun) {
      return;
    }
    setLoading(true);
    try {
      const run = await setOrchestratorRunStatus(
        apiBase,
        token,
        activeRun.runId,
        status,
      );
      setRuns((current) =>
        current.map((item) => (item.runId === run.runId ? run : item)),
      );
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const inject = useMemoizedFn(async () => {
    if (!activeRun || !injectText.trim()) {
      return;
    }
    setLoading(true);
    try {
      const run = await injectOrchestratorPrompt(
        apiBase,
        token,
        activeRun.runId,
        { text: injectText.trim() },
      );
      setRuns((current) =>
        current.map((item) => (item.runId === run.runId ? run : item)),
      );
      setInjectText("");
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  });

  const submitGate = useMemoizedFn(
    async (phase: HumanGatePhase, verdict: HumanGateVerdictValue) => {
      if (!activeRun) {
        return;
      }
      const reason = gateReason.trim();
      setLoading(true);
      try {
        const run = await submitOrchestratorHumanGate(
          apiBase,
          token,
          activeRun.runId,
          {
            phase,
            verdict,
            reason: reason || null,
          },
        );
        setRuns((current) =>
          current.map((item) => (item.runId === run.runId ? run : item)),
        );
        setGateReason("");
        setError(null);
      } catch (caught) {
        setError(handleRequestError(caught));
      } finally {
        setLoading(false);
      }
    },
  );

  const submitRoundConfirmation = useMemoizedFn(
    async (
      confirmationId: string,
      verdict: OrchestratorRoundConfirmationVerdictValue,
    ) => {
      if (!activeRun) {
        return;
      }
      const reason = gateReason.trim();
      setLoading(true);
      try {
        const run = await submitOrchestratorRoundConfirmation(
          apiBase,
          token,
          activeRun.runId,
          {
            confirmationId,
            verdict,
            reason: reason || null,
          },
        );
        setRuns((current) =>
          current.map((item) => (item.runId === run.runId ? run : item)),
        );
        setGateReason("");
        setError(null);
      } catch (caught) {
        setError(handleRequestError(caught));
      } finally {
        setLoading(false);
      }
    },
  );

  const restartFromRun = useMemoizedFn((run: OrchestratorRunPackage) => {
    setTask(run.task);
    setStartupPrompt(normalizeStartupPrompt(run.orchestrator.startupPrompt));
    setOrchestratorMode(run.orchestrator.binding.mode);
    setOrchestratorCommand(
      normalizeAgentCliCommand(run.orchestrator.terminal.command),
    );
    setOrchestratorSessionId(run.orchestrator.sessionId ?? "");
    setRequireHumanConfirmationEachRound(
      Boolean(run.options?.requireHumanConfirmationEachRound),
    );
    setAutoApprovePlanGate(Boolean(run.options?.autoApprovePlanGate));
    setAutoApproveVerifyGate(Boolean(run.options?.autoApproveVerifyGate));
    setRoleDrafts(
      Object.fromEntries(
        run.roles.map((role) => [
          role.id,
          {
            selected: true,
            bindingMode: role.binding.mode,
            sessionId: role.binding.sessionId ?? "",
            prompt: role.prompt,
            skill: role.skill,
          },
        ]),
      ),
    );
    setDraftMode("restart");
  });

  const startBlankRunDraft = useMemoizedFn(() => {
    setTask("");
    setStartupPrompt(DEFAULT_STARTUP_PROMPT);
    setOrchestratorMode("new");
    setOrchestratorCommand("codex");
    setOrchestratorSessionId("");
    setRequireHumanConfirmationEachRound(false);
    setAutoApprovePlanGate(false);
    setAutoApproveVerifyGate(false);
    setRoleDrafts(
      Object.fromEntries(
        roles.map((role) => [
          role.id,
          {
            selected: true,
            bindingMode: "new",
            sessionId: "",
            prompt: role.prompt,
            skill: role.skill,
          },
        ]),
      ),
    );
    setRoleLibraryOpen(false);
    setPromptPreview(null);
    setInjectText("");
    setGateReason("");
    setError(null);
    setDraftMode("blank");
  });

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-slate-400">
        Select a project to configure orchestration.
      </div>
    );
  }

  return (
    <div className="dark flex h-full min-h-0 flex-col overflow-hidden text-slate-100">
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <Workflow className="h-4 w-4 text-sky-300" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Orchestrator</p>
          <p className="truncate text-[11px] text-slate-500">
            {activeProject.name}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 rounded-md px-0"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label="Refresh orchestrator"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      {error ? (
        <p className="border-b border-rose-900/60 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {activeRun &&
        activeRun.status !== "done" &&
        activeRun.status !== "failed" ? (
          <RunMonitor
            run={activeRun}
            loading={loading}
            injectText={injectText}
            gateReason={gateReason}
            onInjectTextChange={setInjectText}
            onGateReasonChange={setGateReason}
            onInject={() => void inject()}
            onHumanGate={(phase, verdict) => void submitGate(phase, verdict)}
            onRoundConfirmation={(confirmationId, verdict) =>
              void submitRoundConfirmation(confirmationId, verdict)
            }
            onPause={() => void setStatus("paused")}
            onResume={() => void setStatus("running")}
            onRestart={() => restartFromRun(activeRun)}
            onNewBlankRun={() => startBlankRunDraft()}
            onSelectSession={onSelectSession}
          />
        ) : (
          <RunConfig
            task={task}
            startupPrompt={startupPrompt}
            orchestratorCommand={orchestratorCommand}
            orchestratorMode={orchestratorMode}
            orchestratorSessionId={orchestratorSessionId}
            requireHumanConfirmationEachRound={
              requireHumanConfirmationEachRound
            }
            autoApprovePlanGate={autoApprovePlanGate}
            autoApproveVerifyGate={autoApproveVerifyGate}
            projectSessions={projectSessions}
            roles={roles}
            roleDrafts={roleDrafts}
            roleLibraryOpen={roleLibraryOpen}
            loading={loading}
            draftMode={draftMode}
            onTaskChange={setTask}
            onStartupPromptChange={setStartupPrompt}
            onOrchestratorCommandChange={setOrchestratorCommand}
            onOrchestratorModeChange={setOrchestratorMode}
            onOrchestratorSessionChange={setOrchestratorSessionId}
            onRequireHumanConfirmationEachRoundChange={
              setRequireHumanConfirmationEachRound
            }
            onAutoApprovePlanGateChange={setAutoApprovePlanGate}
            onAutoApproveVerifyGateChange={setAutoApproveVerifyGate}
            onRoleDraftChange={(roleId, patch) => {
              setRoleDrafts((current) => ({
                ...current,
                [roleId]: {
                  ...(current[roleId] ?? {
                    selected: true,
                    bindingMode: "new",
                    sessionId: "",
                    prompt: "",
                  }),
                  ...patch,
                },
              }));
            }}
            onToggleRoleLibrary={() => setRoleLibraryOpen((open) => !open)}
            onRoleChange={(roleId, patch) => {
              setRoles((current) =>
                current.map((role) =>
                  role.id === roleId ? { ...role, ...patch } : role,
                ),
              );
            }}
            onCancelDraft={() => setDraftMode(null)}
            onSaveRoleLibrary={() => void saveRoleLibrary()}
            onStart={() => void requestStartRun()}
          />
        )}
      </div>
      <RunPromptPreviewDialog
        open={promptPreview !== null}
        loading={loading}
        prompt={promptPreview?.prompt ?? ""}
        runId={promptPreview?.runId ?? ""}
        onClose={() => {
          if (!loading) {
            setPromptPreview(null);
          }
        }}
        onConfirm={() => void startRun()}
      />
    </div>
  );
}
