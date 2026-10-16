import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { SupervisionDecisionSummary } from "@runweave/shared/task-supervision";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { getSupervisionDecisions } from "../../../services/task-supervision";
import { SupervisionDecisionDetails } from "./decision-details";
import { Button } from "../../ui/button";

export function SupervisionHistory({ watchId }: { watchId: string }) {
  const { apiBase, token } = useTerminalRuntime();
  const [records, setRecords] = useState<SupervisionDecisionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = useMemoizedFn(async () => {
    if (pending.current || cursor === null) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(null);
    try {
      const page = await getSupervisionDecisions(
        apiBase,
        token,
        watchId,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRecords((previous) => [...previous, ...page.decisions]);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "历史读取失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (pending.current === controller) pending.current = null;
    }
  });
  return (
    <details
      className="space-y-3 text-xs text-slate-400"
      onToggle={(event) => {
        if (event.currentTarget.open && cursor === undefined) void load();
      }}
    >
      <summary className="cursor-pointer text-sky-400">历史判断</summary>
      {records.map((decision) => (
        <section
          key={decision.decisionId}
          className="space-y-2 rounded border border-slate-800 p-3"
        >
          <p>{decision.goalPreview}</p>
          <p>{decision.goalVersion ? `目标 v${decision.goalVersion}` : "旧版目标"}</p>
          <p>
            {new Date(decision.createdAt).toLocaleString()} ·{" "}
            {decision.outcome === "completed"
              ? "任务已完成"
              : decision.outcome === "blocked"
                ? "需要你处理"
                : "任务可以继续"}
          </p>
          <p className="break-all">thread {decision.threadId}</p>
          <SupervisionDecisionDetails watchId={watchId} decision={decision} />
        </section>
      ))}
      {error && <p role="status">{error}</p>}
      {cursor !== null && (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "正在读取…" : error ? "重试" : "加载更多"}
        </Button>
      )}
      {cursor === null && records.length === 0 && <p>暂无历史判断。</p>}
    </details>
  );
}
