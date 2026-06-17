import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  CheckCircle,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Workflow,
  XCircle,
} from "lucide-react";
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
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

const DEFAULT_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent。你负责 Do-A-IDEM 基础流程：plan -> plan_review -> human_plan_approval -> code -> code_review -> human_verify -> finalize -> done。按 using-rw skill 使用现有 rw 终端命令派发 worker，读取 summary 后决定下一步，不要跳过人工门禁。";
const LEGACY_STARTUP_PROMPT =
  "你是 Runweave 主控 Agent。你负责拆解任务、用 rw run 派发 worker、接收结果后决定下一步，并在完成或需要人工时更新 run 状态。";
const RUN_AUTO_REFRESH_INTERVAL_MS = 3000;

type AgentCliCommand = "codex" | "traex";

const AGENT_CLI_OPTIONS: Array<{ value: AgentCliCommand; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "traex", label: "Traex" },
];

interface TerminalOrchestratorPanelProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  sessions: TerminalSessionListItem[];
  onAuthExpired?: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}

interface RoleDraft {
  selected: boolean;
  bindingMode: "new" | "reuse";
  sessionId: string;
  prompt: string;
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
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [roleLibraryOpen, setRoleLibraryOpen] = useState(false);
  const [restartMode, setRestartMode] = useState(false);
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
    if (restartMode) {
      return null;
    }
    return (
      runs.find((run) =>
        ["running", "paused", "need_human"].includes(run.status),
      ) ??
      runs[0] ??
      null
    );
  }, [restartMode, runs]);

  const handleRequestError = useCallback(
    (caught: unknown) => {
      if (caught instanceof HttpError && caught.status === 401) {
        onAuthExpired?.();
        return "Unauthorized";
      }
      return caught instanceof Error ? caught.message : String(caught);
    },
    [onAuthExpired],
  );

  const refresh = useCallback(async () => {
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
  }, [activeProject, apiBase, handleRequestError, token]);

  const refreshRuns = useCallback(
    async (options?: { silent?: boolean }) => {
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
    },
    [activeProject, apiBase, handleRequestError, token],
  );

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

  const buildRunPayload = useCallback(
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
        },
      };
    },
    [
      activeProject,
      orchestratorCommand,
      orchestratorMode,
      orchestratorSessionId,
      requireHumanConfirmationEachRound,
      roleDrafts,
      roles,
      startupPrompt,
      task,
    ],
  );

  const requestStartRun = useCallback(async () => {
    const payload = buildRunPayload();
    if (!payload) {
      return;
    }
    setLoading(true);
    try {
      const preview = await previewOrchestratorRunPrompt(apiBase, token, payload);
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
  }, [apiBase, buildRunPayload, handleRequestError, token]);

  const startRun = useCallback(async () => {
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
      setRestartMode(false);
      setPromptPreview(null);
      setError(null);
    } catch (caught) {
      setError(handleRequestError(caught));
    } finally {
      setLoading(false);
    }
  }, [
    apiBase,
    handleRequestError,
    promptPreview,
    token,
  ]);

  const saveRoleLibrary = useCallback(async () => {
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
  }, [apiBase, handleRequestError, roles, token]);

  const setStatus = useCallback(
    async (status: OrchestratorRunStatus) => {
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
    },
    [activeRun, apiBase, handleRequestError, token],
  );

  const inject = useCallback(async () => {
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
  }, [activeRun, apiBase, handleRequestError, injectText, token]);

  const submitGate = useCallback(
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
    [activeRun, apiBase, gateReason, handleRequestError, token],
  );

  const submitRoundConfirmation = useCallback(
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
    [activeRun, apiBase, gateReason, handleRequestError, token],
  );

  const restartFromRun = useCallback((run: OrchestratorRunPackage) => {
    setTask(run.task);
    setStartupPrompt(normalizeStartupPrompt(run.orchestrator.startupPrompt));
    setOrchestratorMode(run.orchestrator.binding.mode);
    setOrchestratorCommand(normalizeAgentCliCommand(
      run.orchestrator.terminal.command,
    ));
    setOrchestratorSessionId(run.orchestrator.sessionId ?? "");
    setRequireHumanConfirmationEachRound(
      Boolean(run.options?.requireHumanConfirmationEachRound),
    );
    setRoleDrafts(
      Object.fromEntries(
        run.roles.map((role) => [
          role.id,
          {
            selected: true,
            bindingMode: role.binding.mode,
            sessionId: role.binding.sessionId ?? "",
            prompt: role.prompt,
          },
        ]),
      ),
    );
    setRestartMode(true);
  }, []);

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
            projectSessions={projectSessions}
            roles={roles}
            roleDrafts={roleDrafts}
            roleLibraryOpen={roleLibraryOpen}
            loading={loading}
            restartMode={restartMode}
            onTaskChange={setTask}
            onStartupPromptChange={setStartupPrompt}
            onOrchestratorCommandChange={setOrchestratorCommand}
            onOrchestratorModeChange={setOrchestratorMode}
            onOrchestratorSessionChange={setOrchestratorSessionId}
            onRequireHumanConfirmationEachRoundChange={
              setRequireHumanConfirmationEachRound
            }
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
            onCancelRestart={() => setRestartMode(false)}
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

function RunPromptPreviewDialog(props: {
  open: boolean;
  loading: boolean;
  prompt: string;
  runId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.loading) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>确认主 Agent Prompt</DialogTitle>
          <DialogDescription>
            Run: {props.runId || "pending"}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted p-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
          {props.prompt}
        </pre>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.loading}
            onClick={props.onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={props.loading}
            onClick={props.onConfirm}
          >
            {props.loading ? "启动中..." : "确认并开始 Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentCliSelect(props: {
  value: AgentCliCommand;
  onChange: (value: AgentCliCommand) => void;
}) {
  return (
    <select
      value={props.value}
      onChange={(event) =>
        props.onChange(normalizeAgentCliCommand(event.target.value))
      }
      className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
    >
      {AGENT_CLI_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function RunConfig(props: {
  task: string;
  startupPrompt: string;
  orchestratorCommand: AgentCliCommand;
  orchestratorMode: "new" | "reuse";
  orchestratorSessionId: string;
  requireHumanConfirmationEachRound: boolean;
  projectSessions: TerminalSessionListItem[];
  roles: OrchestratorRoleDefinition[];
  roleDrafts: Record<string, RoleDraft>;
  roleLibraryOpen: boolean;
  loading: boolean;
  restartMode: boolean;
  onTaskChange: (value: string) => void;
  onStartupPromptChange: (value: string) => void;
  onOrchestratorCommandChange: (value: AgentCliCommand) => void;
  onOrchestratorModeChange: (value: "new" | "reuse") => void;
  onOrchestratorSessionChange: (value: string) => void;
  onRequireHumanConfirmationEachRoundChange: (value: boolean) => void;
  onRoleDraftChange: (roleId: string, patch: Partial<RoleDraft>) => void;
  onToggleRoleLibrary: () => void;
  onRoleChange: (
    roleId: string,
    patch: Partial<OrchestratorRoleDefinition>,
  ) => void;
  onCancelRestart: () => void;
  onSaveRoleLibrary: () => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-4">
      {props.restartMode ? (
        <div className="flex items-center gap-2 rounded-md border border-sky-700/70 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">
          <span className="min-w-0 flex-1">已带入上一次流程配置，可直接开始新的 Run。</span>
          <button
            type="button"
            className="shrink-0 text-sky-300 hover:text-sky-100"
            onClick={props.onCancelRestart}
          >
            取消
          </button>
        </div>
      ) : null}
      <label className="block text-xs text-slate-400">
        <span className="mb-1 block">任务/计划</span>
        <textarea
          value={props.task}
          onChange={(event) => props.onTaskChange(event.target.value)}
          className="min-h-24 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-600"
        />
      </label>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">主 Agent</div>
        <AgentCliSelect
          value={props.orchestratorCommand}
          onChange={props.onOrchestratorCommandChange}
        />
        <BindingControls
          mode={props.orchestratorMode}
          sessionId={props.orchestratorSessionId}
          sessions={props.projectSessions}
          onModeChange={props.onOrchestratorModeChange}
          onSessionChange={props.onOrchestratorSessionChange}
        />
        <textarea
          value={props.startupPrompt}
          onChange={(event) => props.onStartupPromptChange(event.target.value)}
          className="min-h-20 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
        />
        <label className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-2 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={props.requireHumanConfirmationEachRound}
            onChange={(event) =>
              props.onRequireHumanConfirmationEachRoundChange(
                event.target.checked,
              )
            }
          />
          <span className="min-w-0 flex-1">每一轮都需要人工确认</span>
        </label>
      </section>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs font-medium text-slate-300">
            参与角色
          </div>
          <button
            type="button"
            className="text-xs text-sky-300 hover:text-sky-200"
            onClick={props.onToggleRoleLibrary}
          >
            管理全局角色定义
          </button>
        </div>
        {props.roleLibraryOpen ? (
          <div className="space-y-3 border-y border-slate-800 py-3">
            {props.roles.map((role) => (
              <div key={role.id} className="space-y-2">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <input
                    value={role.name}
                    onChange={(event) =>
                      props.onRoleChange(role.id, { name: event.target.value })
                    }
                    className="h-8 min-w-0 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600"
                  />
                  <AgentCliSelect
                    value={normalizeAgentCliCommand(role.terminal.command)}
                    onChange={(command) =>
                      props.onRoleChange(role.id, {
                        terminal: {
                          ...role.terminal,
                          command,
                          args: [],
                        },
                      })
                    }
                  />
                </div>
                <textarea
                  value={role.prompt}
                  onChange={(event) =>
                    props.onRoleChange(role.id, { prompt: event.target.value })
                  }
                  className="min-h-16 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
                />
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              className="h-8 w-full rounded-md text-xs"
              disabled={props.loading}
              onClick={props.onSaveRoleLibrary}
            >
              保存角色定义
            </Button>
          </div>
        ) : null}
        {props.roles.map((role) => {
          const draft = props.roleDrafts[role.id];
          return (
            <div key={role.id} className="space-y-2 border-t border-slate-800 py-2">
              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={draft?.selected ?? true}
                  onChange={(event) =>
                    props.onRoleDraftChange(role.id, {
                      selected: event.target.checked,
                    })
                  }
                />
                <span>{role.name}</span>
                <span className="text-slate-500">{role.id}</span>
              </label>
              <BindingControls
                mode={draft?.bindingMode ?? "new"}
                sessionId={draft?.sessionId ?? ""}
                sessions={props.projectSessions}
                onModeChange={(mode) =>
                  props.onRoleDraftChange(role.id, { bindingMode: mode })
                }
                onSessionChange={(sessionId) =>
                  props.onRoleDraftChange(role.id, { sessionId })
                }
              />
              <textarea
                value={draft?.prompt ?? role.prompt}
                onChange={(event) =>
                  props.onRoleDraftChange(role.id, {
                    prompt: event.target.value,
                  })
                }
                className="min-h-16 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
              />
            </div>
          );
        })}
      </section>
      <Button
        type="button"
        className="h-8 w-full rounded-md text-xs"
        disabled={props.loading || !props.task.trim()}
        onClick={props.onStart}
      >
        开始 Run
      </Button>
    </div>
  );
}

function BindingControls(props: {
  mode: "new" | "reuse";
  sessionId: string;
  sessions: TerminalSessionListItem[];
  onModeChange: (mode: "new" | "reuse") => void;
  onSessionChange: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "new"}
          onChange={() => props.onModeChange("new")}
        />
        新建终端
      </label>
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "reuse"}
          onChange={() => props.onModeChange("reuse")}
        />
        复用
      </label>
      <select
        value={props.sessionId}
        disabled={props.mode !== "reuse"}
        onChange={(event) => props.onSessionChange(event.target.value)}
        className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600 disabled:opacity-50"
      >
        <option value="">选择终端</option>
        {props.sessions.map((session) => (
          <option key={session.terminalSessionId} value={session.terminalSessionId}>
            {formatTerminalSessionName({
              alias: session.alias,
              cwd: session.cwd,
              activeCommand: session.activeCommand,
            })}
          </option>
        ))}
      </select>
    </div>
  );
}

function RunMonitor(props: {
  run: OrchestratorRunPackage;
  loading: boolean;
  injectText: string;
  gateReason: string;
  onInjectTextChange: (value: string) => void;
  onGateReasonChange: (value: string) => void;
  onInject: () => void;
  onHumanGate: (phase: HumanGatePhase, verdict: HumanGateVerdictValue) => void;
  onRoundConfirmation: (
    confirmationId: string,
    verdict: OrchestratorRoundConfirmationVerdictValue,
  ) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}) {
  const currentGatePhase =
    props.run.currentPhase === "human_plan_approval" ||
    props.run.currentPhase === "human_verify"
      ? props.run.currentPhase
      : null;
  const summaries = props.run.goals.filter((goal) => goal.result?.summary);
  return (
    <div className="space-y-4">
      {props.run.status === "need_human" ? (
        <div className="rounded-md border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          需要人工介入：
          {props.run.pendingRoundConfirmation
            ? "轮次确认"
            : phaseLabel(props.run.currentPhase)}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{props.run.task}</p>
          <p className="text-[11px] text-slate-500">Run: {props.run.runId}</p>
        </div>
        <StatusBadge status={props.run.status} />
      </div>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs font-medium text-slate-300">
            当前阶段
          </div>
          <span className="shrink-0 rounded border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">
            {props.run.currentPhase ?? "unknown"}
          </span>
        </div>
        <PhaseRail currentPhase={props.run.currentPhase} />
      </section>
      {currentGatePhase ? (
        <HumanGateCard
          phase={currentGatePhase}
          loading={props.loading}
          reason={props.gateReason}
          onReasonChange={props.onGateReasonChange}
          onSubmit={props.onHumanGate}
          injectText={props.injectText}
          onInject={props.onInject}
        />
      ) : null}
      {props.run.pendingRoundConfirmation ? (
        <RoundConfirmationCard
          pending={props.run.pendingRoundConfirmation}
          loading={props.loading}
          reason={props.gateReason}
          onReasonChange={props.onGateReasonChange}
          onSubmit={props.onRoundConfirmation}
        />
      ) : null}
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">目标进度</div>
        {props.run.goals.length ? (
          props.run.goals.map((goal) => (
            <button
              type="button"
              key={goal.id}
              className="flex w-full items-center gap-2 border-t border-slate-800 py-2 text-left text-xs text-slate-300 hover:text-slate-100"
              onClick={() => {
                if (goal.sessionId) {
                  props.onSelectSession?.(goal.sessionId);
                }
              }}
            >
              <span className="w-5 shrink-0">{goalIcon(goal.status)}</span>
              <span className="min-w-0 flex-1 truncate">{goal.id} {goal.desc}</span>
              <span className="shrink-0 text-slate-500">{goal.assignedRole}</span>
            </button>
          ))
        ) : (
          <p className="text-xs text-slate-500">等待主 Agent 派发目标。</p>
        )}
      </section>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">Summary</div>
        {summaries.length ? (
          summaries.map((goal) => (
            <div key={goal.id} className="border-t border-slate-800 py-2 text-xs">
              <div className="flex items-center gap-2 text-slate-300">
                <span className="min-w-0 flex-1 truncate">{goal.id}</span>
                <span className="shrink-0 text-slate-500">
                  {goal.assignedRole}
                </span>
              </div>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-500">
                {goal.result?.summary}
              </p>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-500">等待 worker summary。</p>
        )}
      </section>
      {props.run.humanGateVerdicts?.length ? (
        <section className="space-y-2">
          <div className="text-xs font-medium text-slate-300">人工门禁记录</div>
          {props.run.humanGateVerdicts.map((verdict) => (
            <div key={verdict.id} className="border-t border-slate-800 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">{formatTime(verdict.at)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-200">
                  {phaseLabel(verdict.phase)} {verdict.verdict}
                </span>
              </div>
              {verdict.reason ? (
                <p className="mt-1 line-clamp-3 text-slate-500">
                  {verdict.reason}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {props.run.roundConfirmations?.length ? (
        <section className="space-y-2">
          <div className="text-xs font-medium text-slate-300">轮次确认记录</div>
          {props.run.roundConfirmations.map((confirmation) => (
            <div key={confirmation.id} className="border-t border-slate-800 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">
                  {formatTime(confirmation.at)}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-200">
                  {phaseLabel(confirmation.fromPhase)} {"->"} {phaseLabel(confirmation.nextPhase)} {confirmation.verdict}
                </span>
              </div>
              {confirmation.reason ? (
                <p className="mt-1 line-clamp-3 text-slate-500">
                  {confirmation.reason}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">人工介入</div>
        <textarea
          value={props.injectText}
          onChange={(event) => props.onInjectTextChange(event.target.value)}
          className="min-h-20 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={props.loading || !props.injectText.trim()}
            onClick={props.onInject}
          >
            <MessageSquare />
            注入提示
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || props.run.status === "paused"}
            onClick={props.onPause}
          >
            <Pause />
            暂停
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || props.run.status === "running"}
            onClick={props.onResume}
          >
            <Play />
            继续
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading}
            onClick={props.onRestart}
          >
            <RotateCcw />
            重新开始
          </Button>
        </div>
      </section>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">时间线</div>
        {props.run.timeline.map((item) => (
          <div key={item.id} className="border-t border-slate-800 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">{formatTime(item.at)}</span>
              <span className="min-w-0 flex-1 truncate text-slate-200">
                {item.title}
              </span>
            </div>
            {item.detail ? (
              <p className="mt-1 line-clamp-3 text-slate-500">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

const DO_A_IDEM_PHASES = [
  "discuss",
  "plan",
  "plan_review",
  "human_plan_approval",
  "code",
  "code_review",
  "human_verify",
  "finalize",
  "done",
] as const;

function PhaseRail(props: {
  currentPhase: OrchestratorRunPackage["currentPhase"];
}) {
  const currentIndex = props.currentPhase
    ? DO_A_IDEM_PHASES.indexOf(props.currentPhase)
    : -1;
  return (
    <div className="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-3">
      {DO_A_IDEM_PHASES.map((phase, index) => {
        const active = phase === props.currentPhase;
        const complete = currentIndex >= 0 && index < currentIndex;
        return (
          <div
            key={phase}
            className={[
              "min-w-0 rounded border px-2 py-1",
              active
                ? "border-sky-500 bg-sky-950/40 text-sky-100"
                : complete
                  ? "border-emerald-800/70 text-emerald-200"
                  : "border-slate-800 text-slate-500",
            ].join(" ")}
          >
            <span className="block truncate">{phaseLabel(phase)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HumanGateCard(props: {
  phase: HumanGatePhase;
  loading: boolean;
  reason: string;
  injectText: string;
  onReasonChange: (value: string) => void;
  onSubmit: (phase: HumanGatePhase, verdict: HumanGateVerdictValue) => void;
  onInject: () => void;
}) {
  const isVerify = props.phase === "human_verify";
  const rejectDisabled = props.loading || !props.reason.trim();
  return (
    <section className="space-y-2 rounded-md border border-amber-800/70 bg-amber-950/20 px-3 py-3">
      <div className="text-xs font-medium text-amber-100">
        {isVerify ? "人工验收" : "计划审批"}
      </div>
      <textarea
        value={props.reason}
        onChange={(event) => props.onReasonChange(event.target.value)}
        placeholder={isVerify ? "不通过原因" : "拒绝原因"}
        className="min-h-16 w-full resize-y rounded-md border border-amber-900/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-amber-500"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.loading}
          onClick={() => props.onSubmit(props.phase, "approved")}
        >
          <CheckCircle />
          {isVerify ? "通过，进入提交" : "通过"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rejectDisabled}
          onClick={() => props.onSubmit(props.phase, "rejected")}
        >
          <XCircle />
          {isVerify ? "不通过，返回修改" : "拒绝并要求修订"}
        </Button>
        {isVerify ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || !props.injectText.trim()}
            onClick={props.onInject}
          >
            <MessageSquare />
            补充验证/提问
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function RoundConfirmationCard(props: {
  pending: NonNullable<OrchestratorRunPackage["pendingRoundConfirmation"]>;
  loading: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  onSubmit: (
    confirmationId: string,
    verdict: OrchestratorRoundConfirmationVerdictValue,
  ) => void;
}) {
  const rejectDisabled = props.loading || !props.reason.trim();
  return (
    <section className="space-y-2 rounded-md border border-amber-800/70 bg-amber-950/20 px-3 py-3">
      <div className="text-xs font-medium text-amber-100">轮次确认</div>
      <div className="space-y-1 text-xs text-slate-300">
        <div>
          {phaseLabel(props.pending.fromPhase)} {"->"} {phaseLabel(props.pending.nextPhase)}
        </div>
        <div className="text-slate-500">
          {props.pending.goalId ?? props.pending.roleId ?? props.pending.id}
        </div>
        <p className="line-clamp-4 whitespace-pre-wrap text-slate-400">
          {props.pending.summary}
        </p>
      </div>
      <textarea
        value={props.reason}
        onChange={(event) => props.onReasonChange(event.target.value)}
        placeholder="不通过原因"
        className="min-h-16 w-full resize-y rounded-md border border-amber-900/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-amber-500"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.loading}
          onClick={() => props.onSubmit(props.pending.id, "approved")}
        >
          <CheckCircle />
          通过，进入下一阶段
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rejectDisabled}
          onClick={() => props.onSubmit(props.pending.id, "rejected")}
        >
          <XCircle />
          不通过，返回修改
        </Button>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: OrchestratorRunStatus }) {
  return (
    <span className="rounded border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">
      {status}
    </span>
  );
}

function phaseLabel(phase: OrchestratorRunPackage["currentPhase"]): string {
  if (phase === "discuss") {
    return "需求讨论";
  }
  if (phase === "plan") {
    return "计划";
  }
  if (phase === "plan_review") {
    return "计划审查";
  }
  if (phase === "human_plan_approval") {
    return "计划审批";
  }
  if (phase === "code") {
    return "代码执行";
  }
  if (phase === "code_review") {
    return "代码审查";
  }
  if (phase === "human_verify") {
    return "人工验收";
  }
  if (phase === "finalize") {
    return "收尾提交";
  }
  if (phase === "done") {
    return "完成";
  }
  return "未记录";
}

function goalIcon(status: string): string {
  if (status === "done") {
    return "OK";
  }
  if (status === "running") {
    return ">";
  }
  if (status === "blocked") {
    return "II";
  }
  if (status === "failed") {
    return "X";
  }
  return ".";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function normalizeAgentCliCommand(value: string | undefined): AgentCliCommand {
  return value === "traex" ? "traex" : "codex";
}

function normalizeStartupPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed === LEGACY_STARTUP_PROMPT) {
    return DEFAULT_STARTUP_PROMPT;
  }
  if (trimmed.startsWith(LEGACY_STARTUP_PROMPT)) {
    return `${DEFAULT_STARTUP_PROMPT}${trimmed.slice(LEGACY_STARTUP_PROMPT.length)}`;
  }
  return value;
}
