import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  CreateWorktreeContextRequest,
  WorktreeCreatePreviewResponse,
} from "@runweave/shared/terminal/project-context";
import {
  createWorktreeContext,
  previewWorktreeCreation,
  recycleWorktreeContext,
} from "../../../services/terminal/projects";
import { createTerminalSession } from "../../../services/terminal/sessions";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";

type DialogMode = "recycle" | "share" | "create";

export interface WorktreeDialogResult {
  projectId: string;
  terminalSessionId: string | null;
  setupStatus?: "skipped" | "running" | "revision_mismatch_skipped";
}

export function WorktreeCreateDialog({
  apiBase,
  token,
  parent,
  initialRecycleSlotId,
  close,
  created,
}: {
  apiBase: string;
  token: string;
  parent: string;
  initialRecycleSlotId?: string | null;
  close: () => void;
  created: (result: WorktreeDialogResult) => void;
}) {
  const [preview, setPreview] = useState<WorktreeCreatePreviewResponse>();
  const [mode, setMode] = useState<DialogMode>(
    initialRecycleSlotId ? "recycle" : "create",
  );
  const [recycleSlotId, setRecycleSlotId] = useState(
    initialRecycleSlotId ?? "",
  );
  const [shareContextId, setShareContextId] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBase] = useState("");
  const [deletePreviousBranch, setDeletePreviousBranch] = useState(true);
  const [agent, setAgent] =
    useState<CreateWorktreeContextRequest["launchAgent"]>("none");
  const [existing, setExisting] = useState(false);
  const [approved, setApproved] = useState(false);
  const [runSetupOnRecycle, setRunSetupOnRecycle] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef({ payload: "", id: "" });
  const mounted = useRef(false);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    void previewWorktreeCreation(apiBase, token, parent)
      .then((value) => {
        if (!current) return;
        setPreview(value);
        setBase(value.defaultBaseRef);
        setApproved(value.setup?.approved ?? false);
        const slots = value.recyclableSlots ?? [];
        const shareable = value.shareableContexts ?? [];
        if (initialRecycleSlotId) {
          setMode("recycle");
          setRecycleSlotId(initialRecycleSlotId);
        } else if (slots.length > 0) {
          setMode("recycle");
          setRecycleSlotId(slots[0]!.childProjectId);
        } else {
          setMode("create");
        }
        if (shareable.length > 0) {
          setShareContextId(shareable[0]!.projectId);
        }
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [apiBase, token, parent, initialRecycleSlotId]);

  const submit = useMemoizedFn(async () => {
    if (busy || !preview) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "recycle") {
        if (!recycleSlotId) {
          setError("请选择要复用的空闲槽位");
          return;
        }
        const fields = {
          childProjectId: recycleSlotId,
          newBranch: branch.trim(),
          baseRef: baseRef.trim(),
          deletePreviousBranch,
          closeIdleTerminals: true,
          runSetup: runSetupOnRecycle && approved,
          approvedSetupRevision:
            runSetupOnRecycle && approved ? preview.setup?.revision : undefined,
          launchAgent: agent,
        };
        const payload = JSON.stringify(["recycle", fields]);
        if (operation.current.payload !== payload) {
          operation.current = { payload, id: crypto.randomUUID() };
        }
        const result = await recycleWorktreeContext(
          apiBase,
          token,
          parent,
          recycleSlotId,
          {
            operationId: operation.current.id,
            newBranch: fields.newBranch,
            baseRef: fields.baseRef,
            deletePreviousBranch: fields.deletePreviousBranch,
            closeIdleTerminals: fields.closeIdleTerminals,
            runSetup: fields.runSetup,
            approvedSetupRevision: fields.approvedSetupRevision,
            launchAgent: fields.launchAgent,
          },
        );
        if (mounted.current) {
          created({
            projectId: result.context.projectId,
            terminalSessionId: result.terminalSessionId,
            setupStatus: result.setupStatus,
          });
        }
        return;
      }

      if (mode === "share") {
        if (!shareContextId) {
          setError("请选择要共享并行的 Worktree");
          return;
        }
        const session = await createTerminalSession(apiBase, token, {
          projectId: shareContextId,
        });
        if (mounted.current) {
          created({
            projectId: shareContextId,
            terminalSessionId: session.terminalSessionId,
          });
        }
        return;
      }

      const fields = {
        name,
        branch: branch || name,
        ...(existing ? {} : { baseRef }),
        launchAgent: agent,
        checkoutExistingBranch: existing,
        runSetup: approved,
        approvedSetupRevision: approved ? preview.setup?.revision : undefined,
      };
      const payload = JSON.stringify(["create", fields]);
      if (operation.current.payload !== payload) {
        operation.current = { payload, id: crypto.randomUUID() };
      }
      const result = await createWorktreeContext(apiBase, token, parent, {
        ...fields,
        operationId: operation.current.id,
      });
      if (mounted.current) {
        created({
          projectId: result.context.projectId,
          terminalSessionId: result.terminalSessionId,
          setupStatus: result.setupStatus,
        });
      }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  });

  const recyclableSlots = preview?.recyclableSlots ?? [];
  const shareableContexts = preview?.shareableContexts ?? [];
  const overSoftLimit =
    (preview?.unpinnedWorktreeCount ?? 0) >=
    (preview?.maxUnpinnedSoftLimit ?? 3);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[90vh] overflow-auto"
      >
        <DialogTitle>Worktree 工作区</DialogTitle>
        <form
          className="grid gap-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-3 gap-1 rounded-md border border-slate-800 bg-slate-900/70 p-1 text-xs">
            <button
              type="button"
              data-testid="worktree-mode-recycle"
              disabled={busy || recyclableSlots.length === 0}
              onClick={() => {
                setMode("recycle");
                if (!recycleSlotId && recyclableSlots[0]) {
                  setRecycleSlotId(recyclableSlots[0].childProjectId);
                }
              }}
              className={[
                "rounded px-2 py-1.5 font-medium transition-colors disabled:opacity-40",
                mode === "recycle"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-800",
              ].join(" ")}
            >
              复用空闲槽位 ({recyclableSlots.length})
            </button>
            <button
              type="button"
              data-testid="worktree-mode-share"
              disabled={busy || shareableContexts.length === 0}
              onClick={() => {
                setMode("share");
                if (!shareContextId && shareableContexts[0]) {
                  setShareContextId(shareableContexts[0].projectId);
                }
              }}
              className={[
                "rounded px-2 py-1.5 font-medium transition-colors disabled:opacity-40",
                mode === "share"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-800",
              ].join(" ")}
            >
              同分支并行 ({shareableContexts.length})
            </button>
            <button
              type="button"
              data-testid="worktree-mode-create"
              disabled={busy}
              onClick={() => setMode("create")}
              className={[
                "rounded px-2 py-1.5 font-medium transition-colors disabled:opacity-40",
                mode === "create"
                  ? "bg-sky-600 text-white"
                  : "text-slate-300 hover:bg-slate-800",
              ].join(" ")}
            >
              新建独立目录
            </button>
          </div>

          {overSoftLimit && mode === "create" ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              当前已有 {preview?.unpinnedWorktreeCount} 个未置顶 Worktree（建议上限{" "}
              {preview?.maxUnpinnedSoftLimit}）。优先复用已有槽位或在已有目录同分支并行，可省去重装依赖与后续清理成本。
            </p>
          ) : null}

          <fieldset className="grid gap-3" disabled={busy || !preview}>
            {mode === "recycle" ? (
              <>
                <p className="text-xs text-slate-400">
                  原地重置干净槽位到最新基线并切新分支，保留{" "}
                  <code>node_modules</code> 与构建缓存（已置顶槽位复用后仍保持置顶保护）。
                </p>
                <label className="grid gap-1">
                  <span>复用槽位</span>
                  <select
                    data-testid="worktree-recycle-slot-select"
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                    value={recycleSlotId}
                    onChange={(e) => setRecycleSlotId(e.target.value)}
                  >
                    {recyclableSlots.map((slot) => (
                      <option
                        key={slot.childProjectId}
                        value={slot.childProjectId}
                      >
                        {slot.name} ({slot.branch ?? "detached"}
                        {slot.pinned ? " · 已置顶常驻" : " · 空闲槽位"})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span>新分支名</span>
                  <Input
                    required
                    data-testid="worktree-recycle-branch-input"
                    placeholder="feat/my-task"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </label>
                <label className="grid gap-1">
                  <span>基准引用</span>
                  <Input
                    required
                    value={baseRef}
                    onChange={(e) => setBase(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={deletePreviousBranch}
                    onChange={(e) => setDeletePreviousBranch(e.target.checked)}
                  />
                  安全删除该槽位原先已合并的本地分支（<code>git branch -d</code>）
                </label>
                <label className="flex items-center gap-2">
                  <span>复用后启动</span>
                  <select
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
                    value={agent}
                    onChange={(e) => setAgent(e.target.value as typeof agent)}
                  >
                    <option value="none">Shell</option>
                    {["codex", "claude", "pi", "traex", "agy"].map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                {preview?.setup ? (
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={runSetupOnRecycle}
                      onChange={(e) => setRunSetupOnRecycle(e.target.checked)}
                    />
                    重新执行初始化命令（复用场景默认保留缓存跳过）
                  </label>
                ) : null}
              </>
            ) : null}

            {mode === "share" ? (
              <>
                <p className="text-xs text-slate-400">
                  不切分支、不建新目录，直接在所选 Worktree
                  的当前分支下新开第二个并行终端（避免后续清理多个目录）。
                </p>
                <label className="grid gap-1">
                  <span>目标 Worktree</span>
                  <select
                    data-testid="worktree-share-context-select"
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                    value={shareContextId}
                    onChange={(e) => setShareContextId(e.target.value)}
                  >
                    {shareableContexts.map((ctx) => (
                      <option key={ctx.projectId} value={ctx.projectId}>
                        {ctx.name} ({ctx.branch ?? "detached"}
                        {ctx.pinned ? " · 已置顶" : ""}
                        {ctx.runningAgentCount > 0
                          ? ` · ${ctx.runningAgentCount} Agent 运行中`
                          : ""}
                        {ctx.isDirty ? " · 有改动" : ""})
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}

            {mode === "create" ? (
              <>
                <label className="grid gap-1">
                  <span>目录名</span>
                  <Input
                    required
                    maxLength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="grid gap-1">
                  <span>分支</span>
                  <Input
                    placeholder={name}
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    list="worktree-branches"
                  />
                </label>
                <datalist id="worktree-branches">
                  {preview?.branches.map((ref) => (
                    <option key={ref} value={ref} />
                  ))}
                </datalist>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={existing}
                    onChange={(e) => setExisting(e.target.checked)}
                  />
                  检出现有本地分支
                </label>
                {!existing && (
                  <label className="grid gap-1">
                    <span>基准引用</span>
                    <Input
                      required
                      value={baseRef}
                      onChange={(e) => setBase(e.target.value)}
                    />
                  </label>
                )}
                <label className="flex items-center gap-2">
                  <span>创建后启动</span>
                  <select
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
                    value={agent}
                    onChange={(e) => setAgent(e.target.value as typeof agent)}
                  >
                    <option value="none">Shell</option>
                    {["codex", "claude", "pi", "traex", "agy"].map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                {preview?.setup && (
                  <div className="grid gap-1 rounded border border-slate-800 bg-slate-900/60 p-2 text-xs">
                    <span>初始化命令 · {preview.setup.cwd}</span>
                    <pre className="whitespace-pre-wrap break-all text-slate-300">
                      {preview.setup.command}
                    </pre>
                    <code className="break-all text-[11px] text-slate-500">
                      SHA-256 {preview.setup.revision}
                    </code>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={approved}
                        onChange={(e) => setApproved(e.target.checked)}
                      />
                      信任并运行此版本
                    </label>
                  </div>
                )}
              </>
            ) : null}
          </fieldset>
          {error && (
            <p role="alert" className="text-xs text-rose-400">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !preview}>
              {busy
                ? "处理中…"
                : mode === "recycle"
                  ? "原地复用并打开终端"
                  : mode === "share"
                    ? "打开并行终端"
                    : "新建目录"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
