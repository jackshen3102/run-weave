import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  CreateWorktreeContextRequest,
  CreateWorktreeContextResponse,
  WorktreeCreatePreviewResponse,
} from "@runweave/shared/terminal/project-context";
import {
  createWorktreeContext,
  previewWorktreeCreation,
} from "../../../services/terminal/projects";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";

export function WorktreeCreateDialog({
  apiBase,
  token,
  parent,
  close,
  created,
}: {
  apiBase: string;
  token: string;
  parent: string;
  close: () => void;
  created: (result: CreateWorktreeContextResponse) => void;
}) {
  const [preview, setPreview] = useState<WorktreeCreatePreviewResponse>();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBase] = useState("");
  const [agent, setAgent] =
    useState<CreateWorktreeContextRequest["launchAgent"]>("none");
  const [existing, setExisting] = useState(false);
  const [approved, setApproved] = useState(false);
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
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [apiBase, token, parent]);
  const submit = useMemoizedFn(async () => {
    if (busy || !preview) return;
    const fields = {
      name,
      branch: branch || name,
      baseRef,
      launchAgent: agent,
      checkoutExistingBranch: existing,
      runSetup: approved,
      approvedSetupRevision: approved ? preview.setup?.revision : undefined,
    };
    const payload = JSON.stringify(fields);
    if (operation.current.payload !== payload)
      operation.current = { payload, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await createWorktreeContext(apiBase, token, parent, {
        ...fields,
        operationId: operation.current.id,
      });
      if (mounted.current) created(result);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogTitle>新建 Worktree</DialogTitle>
        <form
          className="grid gap-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="grid gap-3" disabled={busy || !preview}>
            <label>
              目录名
              <Input
                required
                maxLength={64}
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              分支
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
            <label>
              <input
                type="checkbox"
                checked={existing}
                onChange={(e) => setExisting(e.target.checked)}
              />{" "}
              检出现有本地分支
            </label>
            {!existing && (
              <label>
                基准引用
                <Input
                  required
                  value={baseRef}
                  onChange={(e) => setBase(e.target.value)}
                />
              </label>
            )}
            <label>
              创建后启动{" "}
              <select
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
              <div className="grid gap-1">
                <span>初始化命令 · {preview.setup.cwd}</span>
                <pre className="whitespace-pre-wrap break-all">
                  {preview.setup.command}
                </pre>
                <code className="break-all text-xs">
                  SHA-256 {preview.setup.revision}
                </code>
                <label>
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(e) => setApproved(e.target.checked)}
                  />{" "}
                  信任并运行此版本
                </label>
              </div>
            )}
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !preview}>
              {busy ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
