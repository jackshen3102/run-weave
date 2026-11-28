import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import {
  HANDOFF_PROMPT_BYTES,
  HANDOFF_TARGET_AGENTS,
  type HandoffContextScope,
  type HandoffPlacement,
  type HandoffTargetAgent,
  type TerminalContextHandoffPreview,
} from "@runweave/shared/terminal/context-handoff";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalSessionsQuery } from "../../../features/terminal/queries/workspace";
import { useTerminalWorkspaceStore } from "../../../features/terminal/state/workspace-store";
import { HttpError } from "../../../services/http";
import {
  createContextHandoff,
  getHandoffPreview,
} from "../../../services/terminal/sessions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import { Button } from "../../ui/button";

const EXECUTE_PLAN_PROMPT =
  "请先完整阅读上述计划文件，按计划在当前项目目录开始实施并完成验证。";

const PROMPT_PRESETS = [
  { label: "按计划开始实施", prompt: EXECUTE_PLAN_PROMPT },
  {
    label: "继续排查并修复",
    prompt: "请基于交接上下文在当前项目目录继续排查问题、完成修复并验证。",
  },
  { label: "先读上下文等我确认", prompt: "" },
] as const;

function defaultTargetAgent(
  sourceProvider: TerminalContextHandoffPreview["sourceProvider"],
): HandoffTargetAgent {
  return sourceProvider === "claude" ? "codex" : "claude";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function ContextHandoffDialog({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const { apiBase, token, scope, onAuthExpired } = useTerminalRuntime();
  const sessions = useTerminalSessionsQuery();
  const [preview, setPreview] = useState<TerminalContextHandoffPreview>();
  const [agent, setAgent] = useState<HandoffTargetAgent>("codex");
  const [placement, setPlacement] = useState<HandoffPlacement>("in_place");
  const [project, setProject] = useState("");
  const [contextScope, setContextScope] =
    useState<HandoffContextScope>("full_conversation");
  const [selectedPlanPaths, setSelectedPlanPaths] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [submit, setSubmit] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const operation = useRef("");
  const active = useRef(false);
  const posting = useRef(false);
  const agentTouched = useRef(false);
  const promptTouched = useRef(false);
  const placementTouched = useRef(false);
  const projectRef = useRef("");

  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    setPreview(undefined);
    getHandoffPreview(apiBase, token, id, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setPreview(value);
        if (!agentTouched.current) {
          setAgent(defaultTargetAgent(value.sourceProvider));
        }
        const nextProject = value.targetProjects.some(
          (item) => item.projectId === projectRef.current,
        )
          ? projectRef.current
          : value.sourceProjectId;
        projectRef.current = nextProject;
        setProject(nextProject);
        if (!placementTouched.current) {
          setPlacement(
            value.canInPlaceHandoff && nextProject === value.sourceProjectId
              ? "in_place"
              : "new_terminal",
          );
        } else if (
          !value.canInPlaceHandoff ||
          nextProject !== value.sourceProjectId
        ) {
          setPlacement("new_terminal");
        }
        const detected = value.detectedPlanFiles ?? [];
        const defaultPlans = detected[0] ? [detected[0].relativePath] : [];
        setSelectedPlanPaths((prev) => {
          const valid = prev.filter((item) =>
            detected.some((candidate) => candidate.relativePath === item),
          );
          return valid.length ? valid : defaultPlans;
        });
        setContextScope(
          detected.length > 0 ? "plan_focused" : "full_conversation",
        );
        if (!promptTouched.current && detected.length > 0) {
          setPrompt(EXECUTE_PLAN_PROMPT);
        }
        operation.current = crypto.randomUUID();
        setError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err));
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [apiBase, token, scope, id, refresh]);

  const sameWorkspace = preview ? project === preview.sourceProjectId : true;
  const canUseInPlace = Boolean(preview?.canInPlaceHandoff && sameWorkspace);
  const effectivePlacement: HandoffPlacement = canUseInPlace
    ? placement
    : "new_terminal";
  const native =
    effectivePlacement === "new_terminal" &&
    Boolean(preview?.canNativeCodexFork) &&
    agent === "codex" &&
    sameWorkspace;
  const effectivePlanPaths = native ? [] : selectedPlanPaths;
  const effectiveContextScope: HandoffContextScope =
    !native &&
    effectivePlanPaths.length > 0 &&
    contextScope === "plan_focused"
      ? "plan_focused"
      : "full_conversation";

  const selectPlacement = useMemoizedFn((next: HandoffPlacement) => {
    placementTouched.current = true;
    setPlacement(next);
    if (next === "in_place" && preview) {
      projectRef.current = preview.sourceProjectId;
      setProject(preview.sourceProjectId);
    }
  });

  const selectProject = useMemoizedFn((nextProject: string) => {
    projectRef.current = nextProject;
    setProject(nextProject);
    if (preview && nextProject !== preview.sourceProjectId) {
      placementTouched.current = true;
      setPlacement("new_terminal");
    }
  });

  const togglePlanFile = useMemoizedFn((relativePath: string) => {
    setSelectedPlanPaths((prev) => {
      const next = prev.includes(relativePath)
        ? prev.filter((item) => item !== relativePath)
        : [...prev, relativePath];
      if (next.length === 0) {
        setContextScope("full_conversation");
      }
      return next;
    });
  });

  const send = useMemoizedFn(async () => {
    if (posting.current || unknown || !preview) return;
    posting.current = true;
    setBusy(true);
    let created: string | undefined;
    let completedPlacement: HandoffPlacement | undefined;
    try {
      const result = await createContextHandoff(apiBase, token, id, {
        operationId: operation.current,
        panelId: preview.sourcePanelId,
        expectedThreadId: preview.sourceThreadId,
        expectedSourceRevision: preview.sourceRevision,
        targetAgent: agent,
        targetProjectId:
          effectivePlacement === "in_place"
            ? preview.sourceProjectId
            : project,
        mode: native ? "native_fork" : "portable_handoff",
        placement: effectivePlacement,
        contextScope: effectiveContextScope,
        planFilePaths: effectivePlanPaths,
        prompt,
        submitPrompt: submit,
      });
      created = result.terminalSessionId;
      completedPlacement = result.placement;
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof HttpError && failure.status === 401) {
        onAuthExpired?.();
        return;
      }
      if (
        failure instanceof HttpError &&
        failure.details &&
        typeof failure.details === "object" &&
        "terminalSessionId" in failure.details &&
        typeof failure.details.terminalSessionId === "string"
      ) {
        created = failure.details.terminalSessionId;
        completedPlacement =
          "placement" in failure.details &&
          (failure.details.placement === "in_place" ||
            failure.details.placement === "new_terminal")
            ? failure.details.placement
            : effectivePlacement;
        useTerminalWorkspaceStore.getState().setRequestError(failure.message);
      } else if (failure instanceof HttpError && failure.status < 500) {
        setError(failure.message);
        setPreview(undefined);
      } else {
        setUnknown(true);
        setError("交接结果未确认，请关闭此窗口并核对终端状态。");
      }
    } finally {
      posting.current = false;
      if (active.current) setBusy(false);
    }
    if (!created || !active.current) return;
    if (completedPlacement === "in_place") {
      useTerminalWorkspaceStore.getState().bumpAgentRecoveryRevision(id);
      await sessions.refetch();
      if (!active.current) return;
      close();
      return;
    }
    await sessions.refetch();
    if (!active.current) return;
    useTerminalWorkspaceStore
      .getState()
      .selectProjectContext(
        resolveTerminalParentProjectId(project),
        project,
        created,
      );
    close();
  });

  const bytes = new TextEncoder().encode(prompt).length;
  const detectedPlanFiles = preview?.detectedPlanFiles ?? [];
  const inPlaceReason =
    preview && !sameWorkspace
      ? "跨工作区交接仅支持交接到新终端"
      : preview?.inPlaceUnavailableReason ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>换 Agent / 交接执行</DialogTitle>
        </DialogHeader>
        {preview ? (
          <>
            <p className="text-xs text-slate-400">
              {preview.sourceProvider} · {preview.totalMessages} 条消息 · 保留{" "}
              {preview.includedTurns} 轮，部分保留 {preview.partialTurns}{" "}
              轮，省略 {preview.omittedTurns} 轮
            </p>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <progress
                className="flex-1"
                value={preview.handoffBytes}
                max={preview.budgetBytes}
              />
              <span>
                {preview.handoffBytes.toLocaleString()} /{" "}
                {preview.budgetBytes.toLocaleString()} 字节
              </span>
            </div>
            <fieldset disabled={busy || unknown} className="grid gap-3 text-sm">
              <div className="grid gap-1.5">
                <span className="text-xs text-slate-300">切换方式</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!preview.canInPlaceHandoff}
                    onClick={() => selectPlacement("in_place")}
                    className={[
                      "rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                      effectivePlacement === "in_place"
                        ? "border-sky-500/80 bg-sky-500/15 text-sky-100"
                        : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700",
                      !preview.canInPlaceHandoff
                        ? "cursor-not-allowed opacity-50"
                        : "",
                    ].join(" ")}
                  >
                    <div className="font-medium">原位替换当前面板</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      留在原项目目录与当前 Tab
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectPlacement("new_terminal")}
                    className={[
                      "rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                      effectivePlacement === "new_terminal"
                        ? "border-sky-500/80 bg-sky-500/15 text-sky-100"
                        : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700",
                    ].join(" ")}
                  >
                    <div className="font-medium">交接到新终端</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      保留原终端，新建 Tab 执行
                    </div>
                  </button>
                </div>
                {inPlaceReason ? (
                  <p className="text-xs text-amber-300/90">{inPlaceReason}</p>
                ) : null}
              </div>

              <label className="grid gap-1 text-xs text-slate-300">
                <span>目标 Agent</span>
                <select
                  className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
                  value={agent}
                  onChange={(e) => {
                    agentTouched.current = true;
                    setAgent(e.target.value as HandoffTargetAgent);
                  }}
                >
                  {HANDOFF_TARGET_AGENTS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              {effectivePlacement === "new_terminal" &&
              preview.targetProjects.length > 1 ? (
                <label className="grid gap-1 text-xs text-slate-300">
                  <span>目标工作区</span>
                  <select
                    className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100"
                    value={project}
                    onChange={(e) => selectProject(e.target.value)}
                  >
                    {preview.targetProjects.map((item) => (
                      <option key={item.projectId} value={item.projectId}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {!native && detectedPlanFiles.length > 0 ? (
                <div className="grid gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-200">
                      原目录计划文件
                    </span>
                    <span className="text-[11px] text-slate-400">
                      目标 Agent 在当前目录直接读取
                    </span>
                  </div>
                  <div className="grid gap-1.5">
                    {detectedPlanFiles.map((file) => {
                      const checked = selectedPlanPaths.includes(
                        file.relativePath,
                      );
                      return (
                        <label
                          key={file.relativePath}
                          className="flex cursor-pointer items-center gap-2 text-xs text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePlanFile(file.relativePath)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                            {file.relativePath}
                          </span>
                          <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                            {file.source === "mentioned"
                              ? "对话提及"
                              : "最近计划"}{" "}
                            · {formatBytes(file.sizeBytes)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedPlanPaths.length > 0 ? (
                    <div className="flex flex-wrap gap-3 border-t border-slate-800 pt-2 text-xs text-slate-300">
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          name="handoff-context-scope"
                          checked={contextScope === "plan_focused"}
                          onChange={() => setContextScope("plan_focused")}
                        />
                        <span>仅带计划与目标（精简上下文）</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="radio"
                          name="handoff-context-scope"
                          checked={contextScope === "full_conversation"}
                          onChange={() => setContextScope("full_conversation")}
                        />
                        <span>完整对话 + 计划</span>
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-xs text-slate-300">附加指令</span>
                  <div className="flex flex-wrap gap-1">
                    {PROMPT_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          promptTouched.current = true;
                          setPrompt(preset.prompt);
                        }}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-600 hover:text-slate-100"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  className="block w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100"
                  rows={4}
                  value={prompt}
                  onChange={(e) => {
                    promptTouched.current = true;
                    setPrompt(e.target.value);
                  }}
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={submit}
                  onChange={(e) => setSubmit(e.target.checked)}
                />
                <span>自动提交首轮</span>
              </label>
            </fieldset>

            {effectivePlacement === "in_place" ? (
              <p className="text-xs text-slate-400">
                将在当前面板结束原 Agent 进程并在原项目目录启动目标
                CLI，原会话仍保留在本地历史中；当前 Tab、Browser
                绑定与随记关联保持不变。
              </p>
            ) : null}
            {native ? (
              <p className="text-xs text-emerald-300">
                将使用 Codex 原生 Fork 保留完整会话。
              </p>
            ) : null}
            {bytes > HANDOFF_PROMPT_BYTES ? (
              <p className="text-xs text-rose-400">附加指令超过 32 KiB。</p>
            ) : null}
          </>
        ) : (
          !error && <p className="text-xs text-slate-400">正在读取来源会话…</p>
        )}
        {error ? (
          <p role="alert" className="text-xs text-rose-400">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {error && !preview ? (
            <Button onClick={() => setRefresh((n) => n + 1)}>刷新预览</Button>
          ) : null}
          <Button
            disabled={
              !preview || busy || unknown || bytes > HANDOFF_PROMPT_BYTES
            }
            onClick={send}
          >
            {busy
              ? effectivePlacement === "in_place"
                ? "正在原位切换…"
                : "正在交接…"
              : effectivePlacement === "in_place"
                ? "原位切换"
                : "交接到新终端"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
