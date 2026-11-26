import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import {
  HANDOFF_PROMPT_BYTES,
  HANDOFF_TARGET_AGENTS,
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
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submit, setSubmit] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const operation = useRef("");
  const active = useRef(false);
  const posting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    setPreview(undefined);
    getHandoffPreview(apiBase, token, id, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setPreview(value);
        setProject((old) =>
          value.targetProjects.some((item) => item.projectId === old)
            ? old
            : value.sourceProjectId,
        );
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
  const native =
    preview?.canNativeCodexFork &&
    agent === "codex" &&
    project === preview.sourceProjectId;
  const send = useMemoizedFn(async () => {
    if (posting.current || unknown || !preview) return;
    posting.current = true;
    setBusy(true);
    let created: string | undefined;
    try {
      const result = await createContextHandoff(apiBase, token, id, {
        operationId: operation.current,
        panelId: preview.sourcePanelId,
        expectedThreadId: preview.sourceThreadId,
        expectedSourceRevision: preview.sourceRevision,
        targetAgent: agent,
        targetProjectId: project,
        mode: native ? "native_fork" : "portable_handoff",
        prompt,
        submitPrompt: submit,
      });
      created = result.terminalSessionId;
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
        useTerminalWorkspaceStore.getState().setRequestError(failure.message);
      } else if (failure instanceof HttpError && failure.status < 500) {
        setError(failure.message);
        setPreview(undefined);
      } else {
        setUnknown(true);
        setError("交接结果未确认，请关闭此窗口并核对终端列表。");
      }
    } finally {
      posting.current = false;
      if (active.current) setBusy(false);
    }
    if (!created || !active.current) return;
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>交接到新终端</DialogTitle>
        </DialogHeader>
        {preview ? (
          <>
            <p>
              {preview.sourceProvider} · {preview.totalMessages} 条消息 · 保留{" "}
              {preview.includedTurns} 轮，部分保留 {preview.partialTurns} 轮，省略 {preview.omittedTurns} 轮
            </p>
            <div>
              <progress
                value={preview.handoffBytes}
                max={preview.budgetBytes}
              />{" "}
              {preview.handoffBytes.toLocaleString()} /{" "}
              {preview.budgetBytes.toLocaleString()} 字节
            </div>
            <fieldset disabled={busy || unknown} className="grid gap-3">
              <label>
                目标 Agent{" "}
                <select
                  value={agent}
                  onChange={(e) =>
                    setAgent(e.target.value as HandoffTargetAgent)
                  }
                >
                  {HANDOFF_TARGET_AGENTS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label>
                目标工作区{" "}
                <select
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  {preview.targetProjects.map((p) => (
                    <option key={p.projectId} value={p.projectId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                附加指令
                <textarea
                  className="block w-full rounded border bg-transparent p-2"
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={submit}
                  onChange={(e) => setSubmit(e.target.checked)}
                />{" "}
                自动提交首轮
              </label>
            </fieldset>
            {native && <p>将使用 Codex 原生 Fork 保留完整会话。</p>}
            {bytes > HANDOFF_PROMPT_BYTES && <p>附加指令超过 32 KiB。</p>}
          </>
        ) : (
          !error && <p>正在读取来源会话…</p>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          {error && !preview && (
            <Button onClick={() => setRefresh((n) => n + 1)}>刷新预览</Button>
          )}
          <Button
            disabled={!preview || busy || unknown || bytes > HANDOFF_PROMPT_BYTES}
            onClick={send}
          >
            {busy ? "正在交接…" : "交接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
