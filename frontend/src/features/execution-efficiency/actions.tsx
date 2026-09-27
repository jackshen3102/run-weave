import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import type {
  EfficiencyFindingDetail,
  EfficiencyFindingEventAction,
} from "@runweave/shared/execution-efficiency";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { HttpError } from "../../services/http";
import { efficiencyKeys, useEfficiencyApi } from "./queries";

const actionLabels: Record<EfficiencyFindingEventAction, string> = {
  "start-processing": "开始处理",
  resolve: "确认已处理",
  defer: "暂不处理",
  dismiss: "排除候选",
  reopen: "重新打开",
  "add-note": "补充结论",
  "ask-analysis": "补充分析",
  "add-evidence": "追加证据",
};

export function EfficiencyFindingActions({
  finding,
}: {
  finding: EfficiencyFindingDetail;
}) {
  const { api, scope } = useEfficiencyApi();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<EfficiencyFindingEventAction>(
    finding.status === "resolved" || finding.status === "dismissed"
      ? "reopen"
      : "start-processing",
  );
  const [note, setNote] = useState("");
  const [verification, setVerification] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.event(
        finding.id,
        {
          expectedRevision: finding.revision,
          action,
          note,
          ...(action === "resolve" ? { verification, confirmed } : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: efficiencyKeys.all(scope) });
      setNote("");
      setVerification("");
      setConfirmed(false);
      setOpen(false);
    },
  });
  const submit = useMemoizedFn(() => {
    if (
      !note.trim() ||
      (action === "resolve" && (!verification.trim() || !confirmed))
    )
      return;
    mutation.mutate();
  });
  const conflict =
    mutation.error instanceof HttpError && mutation.error.status === 409;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">人工处理</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>人工处理</DialogTitle>
          <DialogDescription>
            记录处理动作、结论或补充分析；提交时会校验当前 revision。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            操作
            <select
              className="h-10 rounded-md border bg-background px-3"
              value={action}
              onChange={(event) =>
                setAction(event.target.value as EfficiencyFindingEventAction)
              }
            >
              {Object.entries(actionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            处理说明或问题
            <textarea
              className="min-h-24 rounded-md border bg-background px-3 py-2"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {action === "resolve" ? (
            <>
              <label className="grid gap-1 text-sm sm:col-span-2">
                同条件验证记录
                <textarea
                  className="min-h-24 rounded-md border bg-background px-3 py-2"
                  value={verification}
                  onChange={(event) => setVerification(event.target.value)}
                />
              </label>
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我确认处理结果和验证记录准确，并将该候选标记为已处理
              </label>
            </>
          ) : null}
        </div>
        {mutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {conflict
              ? "记录已被其他页面更新。你的草稿仍保留，请刷新后再决定。"
              : String(mutation.error)}
          </p>
        ) : null}
        <Button
          disabled={
            mutation.isPending ||
            !note.trim() ||
            (action === "resolve" && (!verification.trim() || !confirmed))
          }
          onClick={submit}
        >
          {mutation.isPending ? "提交中…" : actionLabels[action]}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
