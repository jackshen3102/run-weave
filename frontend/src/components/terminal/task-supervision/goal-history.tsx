import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  SupervisionGoalDetail,
  SupervisionGoalPage,
} from "@runweave/shared/task-supervision";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import {
  getTaskSupervisionGoal,
  getTaskSupervisionGoals,
} from "../../../services/task-supervision";
import { Button } from "../../ui/button";
import { GoalSources } from "./goal-panel";

function Revision({
  watchId,
  entry,
}: {
  watchId: string;
  entry: SupervisionGoalPage["goals"][number];
}) {
  const { apiBase, token } = useTerminalRuntime();
  const [detail, setDetail] = useState<SupervisionGoalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = useMemoizedFn(async (open: boolean) => {
    if (!open || detail || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setError(null);
    try {
      const result = await getTaskSupervisionGoal(
        apiBase,
        token,
        watchId,
        entry.goal.revisionId,
        controller.signal,
      );
      if (!controller.signal.aborted) setDetail(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "来源读取失败");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  });
  const goal = entry.goal;
  return (
    <details
      className="space-y-3 rounded border border-slate-800 p-3"
      onToggle={(event) => void load(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sky-400">
        v{goal.version} ·{" "}
        {goal.origin === "manual" ? "手动修订" : "根据对话整理"} ·{" "}
        {new Date(goal.createdAt).toLocaleString()}
      </summary>
      <p className="whitespace-pre-wrap break-words text-slate-200">
        {goal.objective}
      </p>
      <p>完成条件</p>
      <p className="whitespace-pre-wrap break-words">
        {goal.completionCriteria}
      </p>
      {goal.constraints && (
        <>
          <p>范围与约束</p>
          <p className="whitespace-pre-wrap break-words">{goal.constraints}</p>
        </>
      )}
      <p className="break-all text-[11px] text-slate-500">
        会话 {goal.threadId}
      </p>
      {detail ? (
        <GoalSources detail={detail} />
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load(true)}>
            重试
          </Button>
        </>
      ) : (
        <p>正在读取来源…</p>
      )}
    </details>
  );
}
export function SupervisionGoalHistory({ watchId }: { watchId: string }) {
  const { apiBase, token } = useTerminalRuntime();
  const [records, setRecords] = useState<SupervisionGoalPage["goals"]>([]);
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
      const page = await getTaskSupervisionGoals(
        apiBase,
        token,
        watchId,
        cursor,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setRecords((previous) => [...previous, ...page.goals]);
        setCursor(page.nextCursor);
      }
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
      className="space-y-3 text-xs leading-6 text-slate-400"
      onToggle={(event) => {
        if (event.currentTarget.open && cursor === undefined) void load();
      }}
    >
      <summary className="cursor-pointer text-sky-400">目标版本历史</summary>
      {records.map((entry) => (
        <Revision key={entry.goal.revisionId} watchId={watchId} entry={entry} />
      ))}
      {error && <p role="alert">{error}</p>}
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
      {cursor === null && !records.length && <p>暂无已采用的目标版本。</p>}
    </details>
  );
}
