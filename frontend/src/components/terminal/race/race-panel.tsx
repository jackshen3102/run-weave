import { useEffect, useMemo, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Play, Plus, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type {
  RaceAgent,
  RaceAgentCatalog,
  RaceRecord,
  RaceWorkerConfig,
  RaceWorkerRecord,
} from "@runweave/shared/race";
import {
  EMPTY_TERMINAL_SESSIONS,
  useTerminalProjectContextsQuery,
  useTerminalSessionsQuery,
  useTerminalWorkspaceQueryClient,
} from "../../../features/terminal/queries/terminal-workspace-queries";
import { terminalQueryKeys } from "../../../features/terminal/queries/terminal-query-keys";
import { useTerminalRuntime } from "../../../features/terminal/queries/terminal-runtime-provider";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";
import { useTerminalWorkspaceStore } from "../../../features/terminal/workspace-store";
import { HttpError } from "../../../services/http";
import {
  createRace,
  deleteRace,
  getRace,
  getRaceAgents,
} from "../../../services/race";
import { getTerminalProjectPreviewGitChanges } from "../../../services/terminal";
import { TerminalRaceObserver } from "./race-observer";

const EMPTY_AGENT_CATALOG: RaceAgentCatalog = {
  codex: { models: [], custom: true },
  traex: { models: [], custom: true },
};

interface DraftWorker extends RaceWorkerConfig {
  id: number;
  customModel: boolean;
}

let nextDraftWorkerId = 1;

function createDraftWorker(agent: RaceAgent, model = ""): DraftWorker {
  return {
    id: nextDraftWorkerId++,
    agent,
    model,
    customModel: false,
  };
}

function initialDraftWorkers(): DraftWorker[] {
  return [
    createDraftWorker("codex"),
    createDraftWorker("traex"),
    createDraftWorker("traex"),
  ];
}

function describeRequestError(error: unknown): string {
  if (error instanceof HttpError && error.status === 409) {
    return "已有进行中的 Race，请先结束当前 Race。";
  }
  return error instanceof Error ? error.message : String(error);
}

export function TerminalRacePanel() {
  const { apiBase, onAuthExpired, scope, token } = useTerminalRuntime();
  const navigate = useNavigate();
  const { queryClient } = useTerminalWorkspaceQueryClient();
  const activeParentProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const selectProjectContext = useTerminalWorkspaceStore(
    (state) => state.selectProjectContext,
  );
  const terminalStateBySessionId = useTerminalWorkspaceStore(
    (state) => state.terminalStateBySessionId,
  );
  const contextsQuery = useTerminalProjectContextsQuery(activeParentProjectId);
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const primaryContext = contextsQuery.data?.find(
    (context) => context.isPrimary,
  );
  const [race, setRace] = useState<RaceRecord | null>(null);
  const [catalog, setCatalog] = useState<RaceAgentCatalog>(EMPTY_AGENT_CATALOG);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [workers, setWorkers] = useState<DraftWorker[]>(initialDraftWorkers);
  const [changedWorkerIds, setChangedWorkerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseRefTouched = useRef(false);

  const handleAuthError = useMemoizedFn((requestError: unknown): void => {
    if (requestError instanceof HttpError && requestError.status === 401) {
      onAuthExpired?.();
    }
  });

  const refreshRace = useMemoizedFn(async (): Promise<void> => {
    try {
      setRace(await getRace(apiBase, token));
    } catch (requestError) {
      handleAuthError(requestError);
    }
  });

  useEffect(() => {
    void refreshRace();
    const timer = window.setInterval(() => {
      void refreshRace();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refreshRace]);

  useEffect(() => {
    let cancelled = false;
    void getRaceAgents(apiBase, token)
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog);
        }
      })
      .catch((requestError: unknown) => {
        handleAuthError(requestError);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, handleAuthError, token]);

  useEffect(() => {
    setWorkers((current) =>
      current.map((worker) => {
        if (worker.model || worker.customModel) {
          return worker;
        }
        return {
          ...worker,
          model: catalog[worker.agent].models[0] ?? "",
        };
      }),
    );
  }, [catalog]);

  useEffect(() => {
    if (
      baseRefTouched.current ||
      baseRef ||
      (!primaryContext?.branch && !primaryContext?.head)
    ) {
      return;
    }
    setBaseRef(primaryContext.branch ?? primaryContext.head ?? "");
  }, [baseRef, primaryContext?.branch, primaryContext?.head]);

  useEffect(() => {
    if (!race) {
      setChangedWorkerIds(new Set());
      return;
    }
    let cancelled = false;
    const loadChanges = async (): Promise<void> => {
      const changed = new Set<string>();
      await Promise.all(
        race.workers.map(async (worker) => {
          if (!worker.worktreeId || !worker.worktreePath) {
            return;
          }
          try {
            const response = await getTerminalProjectPreviewGitChanges(
              apiBase,
              token,
              worker.worktreeId,
            );
            if (response.staged.length > 0 || response.working.length > 0) {
              changed.add(worker.workerId);
            }
          } catch (requestError) {
            handleAuthError(requestError);
          }
        }),
      );
      if (!cancelled) {
        setChangedWorkerIds(changed);
      }
    };
    void loadChanges();
    const timer = window.setInterval(() => {
      void loadChanges();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiBase, handleAuthError, race, token]);

  const sessionsById = useMemo(
    () =>
      new Map(sessions.map((session) => [session.terminalSessionId, session])),
    [sessions],
  );

  const focusWorker = useMemoizedFn((worker: RaceWorkerRecord): void => {
    if (!race || !worker.worktreeId) {
      return;
    }
    selectProjectContext(
      race.parentProjectId,
      worker.worktreeId,
      worker.terminalSessionId,
    );
    if (worker.terminalSessionId) {
      navigate(`/terminal/${encodeURIComponent(worker.terminalSessionId)}`);
    }
  });

  const openWorkerDiff = useMemoizedFn((worker: RaceWorkerRecord): void => {
    if (!worker.worktreeId) {
      return;
    }
    focusWorker(worker);
    queryClient.removeQueries({
      queryKey: terminalQueryKeys.previewChanges(scope, worker.worktreeId),
      exact: true,
    });
    const previewStore = useTerminalPreviewStore.getState();
    previewStore.openPreview(worker.worktreeId, "changes");
    previewStore.requestChangesRefresh(worker.worktreeId);
  });

  const invalidateRaceResources = useMemoizedFn(
    async (parentProjectId: string): Promise<void> => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: terminalQueryKeys.sessions(scope),
        }),
        queryClient.invalidateQueries({
          queryKey: terminalQueryKeys.projectContexts(scope, parentProjectId),
        }),
      ]);
    },
  );

  const dispatchRace = useMemoizedFn(async (): Promise<void> => {
    if (
      !activeParentProjectId ||
      !goal.trim() ||
      !plan.trim() ||
      !baseRef.trim() ||
      workers.length === 0 ||
      submitting
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createRace(apiBase, token, {
        parentProjectId: activeParentProjectId,
        goal: goal.trim(),
        plan: plan.trim(),
        baseRef: baseRef.trim(),
        workers: workers.map(({ agent, model }) => ({
          agent,
          model: model.trim(),
        })),
      });
      setRace(created);
      await invalidateRaceResources(created.parentProjectId);
      const firstWorker = created.workers.find(
        (worker) =>
          worker.worktreeId &&
          worker.terminalSessionId &&
          worker.launchStatus !== "failed",
      );
      if (firstWorker) {
        focusWorker(firstWorker);
      }
    } catch (requestError) {
      handleAuthError(requestError);
      setError(describeRequestError(requestError));
      await refreshRace();
    } finally {
      setSubmitting(false);
    }
  });

  const endCurrentRace = useMemoizedFn(async (): Promise<void> => {
    if (
      !race ||
      ending ||
      !window.confirm(
        "结束当前 Race 会停止 Worker Terminal，但保留所有 worktree、分支和改动。继续吗？",
      )
    ) {
      return;
    }
    setEnding(true);
    setError(null);
    try {
      await deleteRace(apiBase, token, race.raceId);
      await invalidateRaceResources(race.parentProjectId);
      setRace(null);
      setGoal("");
      setPlan("");
      setWorkers(initialDraftWorkers());
    } catch (requestError) {
      handleAuthError(requestError);
      setError(describeRequestError(requestError));
    } finally {
      setEnding(false);
    }
  });

  const updateWorkerAgent = useMemoizedFn(
    (workerId: number, agent: RaceAgent): void => {
      setWorkers((current) =>
        current.map((worker) =>
          worker.id === workerId
            ? {
                ...worker,
                agent,
                model: catalog[agent].models[0] ?? "",
                customModel: false,
              }
            : worker,
        ),
      );
    },
  );

  const updateWorkerModel = useMemoizedFn(
    (workerId: number, model: string): void => {
      setWorkers((current) =>
        current.map((worker) =>
          worker.id === workerId
            ? model === "__custom__"
              ? { ...worker, model: "", customModel: true }
              : { ...worker, model, customModel: false }
            : worker,
        ),
      );
    },
  );

  if (!race) {
    const dispatchDisabled =
      submitting ||
      !activeParentProjectId ||
      !goal.trim() ||
      !plan.trim() ||
      !baseRef.trim() ||
      workers.length === 0;
    return (
      <div
        className="h-full overflow-y-auto p-3 text-slate-200"
        data-testid="terminal-race-composer"
      >
        <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
          同一目标会并行下发到每个 Worker 的独立 worktree 和 Terminal。 Race
          不评分，也不自动判断 Worker 是否在等待回答。
        </p>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              目标
            </span>
            <input
              className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="修复一个明确问题"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              任务计划 / prompt
            </span>
            <textarea
              className="min-h-20 w-full resize-y rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs leading-relaxed text-slate-100 outline-none focus:border-sky-600"
              value={plan}
              onChange={(event) => setPlan(event.target.value)}
              placeholder="记录任务计划；Worker 收到上方目标原文。"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              baseRef
            </span>
            <input
              className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-600"
              value={baseRef}
              onChange={(event) => {
                baseRefTouched.current = true;
                setBaseRef(event.target.value);
              }}
              placeholder="main"
            />
          </label>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Workers ({workers.length})
              </span>
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                onClick={() =>
                  setWorkers((current) => [
                    ...current,
                    createDraftWorker("codex", catalog.codex.models[0] ?? ""),
                  ])
                }
              >
                <Plus className="h-3 w-3" />加 Worker
              </button>
            </div>
            {workers.map((worker, index) => {
              const knownModels = catalog[worker.agent].models;
              return (
                <div
                  className="rounded border border-slate-800 bg-slate-900/60 p-2"
                  key={worker.id}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="w-14 shrink-0 truncate text-[10px] font-semibold text-slate-300">
                      Worker {String.fromCharCode(65 + index)}
                    </span>
                    <select
                      aria-label={`Worker ${index + 1} agent`}
                      className="h-7 w-[76px] shrink-0 rounded border border-slate-800 bg-slate-950 px-1 text-[11px] text-slate-100 outline-none focus:border-sky-600"
                      value={worker.agent}
                      onChange={(event) =>
                        updateWorkerAgent(
                          worker.id,
                          event.target.value as RaceAgent,
                        )
                      }
                    >
                      <option value="codex">codex</option>
                      <option value="traex">traex</option>
                    </select>
                    <select
                      aria-label={`Worker ${index + 1} model`}
                      className="h-7 min-w-0 flex-1 rounded border border-slate-800 bg-slate-950 px-1 text-[11px] text-slate-100 outline-none focus:border-sky-600"
                      value={
                        worker.customModel ||
                        (worker.model && !knownModels.includes(worker.model))
                          ? "__custom__"
                          : worker.model
                      }
                      onChange={(event) =>
                        updateWorkerModel(worker.id, event.target.value)
                      }
                    >
                      <option value="">默认模型</option>
                      {knownModels.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                      <option value="__custom__">自定义…</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`删除 Worker ${index + 1}`}
                      className="grid h-7 w-6 shrink-0 place-items-center rounded text-slate-500 hover:text-rose-400 disabled:opacity-30"
                      disabled={workers.length === 1}
                      onClick={() =>
                        setWorkers((current) =>
                          current.filter(
                            (candidate) => candidate.id !== worker.id,
                          ),
                        )
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {worker.customModel ? (
                    <input
                      aria-label={`Worker ${index + 1} custom model`}
                      className="mt-1.5 h-7 w-full rounded border border-slate-800 bg-slate-950 px-2 font-mono text-[11px] text-slate-100 outline-none focus:border-sky-600"
                      value={worker.model}
                      onChange={(event) =>
                        setWorkers((current) =>
                          current.map((candidate) =>
                            candidate.id === worker.id
                              ? {
                                  ...candidate,
                                  model: event.target.value,
                                }
                              : candidate,
                          ),
                        )
                      }
                      placeholder="输入传给 agent 的模型名"
                    />
                  ) : null}
                  {worker.agent === "traex" && knownModels.length === 0 ? (
                    <p className="mt-1 text-[10px] text-amber-300">
                      TraeX 模型目录不可用；仍可选择“自定义…”下发。
                    </p>
                  ) : null}
                </div>
              );
            })}
            {workers.length > 5 ? (
              <p className="rounded border border-amber-800/70 bg-amber-950/30 px-2 py-1.5 text-[10px] leading-relaxed text-amber-300">
                {workers.length} 个 Worker 会创建 {workers.length} 份
                worktree，并启动 {workers.length} 个并发 agent 进程。
              </p>
            ) : null}
          </div>
          {error ? (
            <p className="rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-300">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-sky-600 text-xs font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={dispatchDisabled}
            onClick={() => void dispatchRace()}
          >
            <Play className="h-3.5 w-3.5" />
            {submitting ? "正在下发…" : "下发给主 Agent"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <TerminalRaceObserver
      race={race}
      sessionsById={sessionsById}
      terminalStateBySessionId={terminalStateBySessionId}
      changedWorkerIds={changedWorkerIds}
      error={error}
      ending={ending}
      onFocusWorker={focusWorker}
      onOpenWorkerDiff={openWorkerDiff}
      onEndRace={() => void endCurrentRace()}
    />
  );
}
