import { useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  StartSupervisionRequest,
  SupervisionDiscovery,
} from "@runweave/shared/task-supervision";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

export function SupervisionStartDialog({
  discovery,
  busy,
  error,
  onClose,
  onStart,
}: {
  discovery: SupervisionDiscovery;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onStart: (request: StartSupervisionRequest) => Promise<void>;
}) {
  const candidates = discovery.taskCandidates;
  const watch = discovery.watch;
  const initial =
    candidates.find((m) => m.id === watch?.taskStartMessageId) ??
    candidates.at(-1);
  const [startId, setStartId] = useState(initial?.id ?? "");
  const [goal, setGoal] = useState(watch?.goal ?? initial?.text ?? "");
  const [plans, setPlans] = useState(
    watch?.plans.map((p) => p.path).join("\n") ?? "",
  );
  const requestId = useRef(crypto.randomUUID());
  const lastPayload = useRef("");
  const submit = useMemoizedFn(async () => {
    if (!discovery.target || busy) return;
    const payload = {
      target: discovery.target,
      taskStartMessageId: startId,
      goal: goal.trim(),
      planPaths: plans
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
      ...(watch
        ? { replacesWatchId: watch.watchId, expectedRevision: watch.revision }
        : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (lastPayload.current && lastPayload.current !== fingerprint)
      requestId.current = crypto.randomUUID();
    lastPayload.current = fingerprint;
    await onStart({ ...payload, requestId: requestId.current });
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] overflow-y-auto border-slate-800 bg-slate-950 text-slate-100"
      >
        <DialogHeader>
          <DialogTitle>
            {watch ? "重新开启一轮监控" : "开启长任务监控"}
          </DialogTitle>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-amber-300">
            {error}
          </p>
        )}
        <p className="text-xs leading-6 text-slate-400">
          只监听最终回复。独立 Codex 判断完成、阻塞或继续，最多自动续接 3
          次；由原 Agent 实现、测试和验收。
        </p>
        <label className="space-y-2 text-xs">
          原始任务起点
          <select
            aria-label="原始任务起点"
            className="w-full rounded border border-slate-700 bg-slate-900 p-2"
            value={startId}
            onChange={(event) => {
              setStartId(event.target.value);
              setGoal(
                candidates.find((m) => m.id === event.target.value)?.text ?? "",
              );
            }}
          >
            {candidates.map((m) => (
              <option value={m.id} key={m.id}>
                {m.createdAt ? new Date(m.createdAt).toLocaleString() : m.id} ·{" "}
                {m.text.slice(0, 70)}
              </option>
            ))}
          </select>
        </label>
        <details className="text-xs text-slate-400">
          <summary>核对原始任务全文</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">
            {candidates.find((m) => m.id === startId)?.text}
          </pre>
        </details>
        <label className="space-y-2 text-xs">
          当前目标
          <textarea
            aria-label="当前监控目标"
            value={goal}
            maxLength={8000}
            onChange={(event) => setGoal(event.target.value)}
            className="min-h-28 w-full rounded border border-slate-700 bg-slate-900 p-3"
          />
        </label>
        <label className="space-y-2 text-xs">
          计划 / 测试用例引用（项目相对路径，每行一条）
          <p className="text-slate-500">
            留空时读取原对话中的 docs/plans 或 docs/testing
            引用；后续新增引用随最终回复读取。
          </p>
          <textarea
            aria-label="计划引用"
            value={plans}
            onChange={(event) => setPlans(event.target.value)}
            className="min-h-16 w-full rounded border border-slate-700 bg-slate-900 p-2"
          />
        </label>
        <p className="break-all text-[11px] text-slate-500">
          终端 {discovery.target?.terminalSessionId} · panel{" "}
          {discovery.target?.panelId} · thread {discovery.target?.threadId}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              busy ||
              !startId ||
              !goal.trim() ||
              !discovery.capability.supported
            }
            onClick={() => void submit()}
          >
            {busy ? "开启中…" : "确认开启"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
