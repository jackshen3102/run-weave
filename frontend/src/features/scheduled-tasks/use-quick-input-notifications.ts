import { useEffect, useState } from "react";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { scheduledTasksApi } from "../../services/scheduled-tasks";

export interface QuickInputNotice {
  runId: string;
  taskId: string;
  title: string;
  body: string;
}

function noticeFor(run: ScheduledRun): QuickInputNotice {
  const origin = run.snapshot.origin!;
  const project = `${origin.projectName}${origin.worktreeName ? ` / ${origin.worktreeName}` : ""}`;
  const success = run.status === "completed" && run.outcome === "succeeded";
  return {
    runId: run.id,
    taskId: run.taskId,
    title: `${project} · ${success ? "已完成" : "需要处理"}`.slice(-120),
    body: `${run.snapshot.name} · ${success ? "打开查看结果" : "失败或受阻，打开查看原因"}`.slice(0, 240),
  };
}

export function useQuickInputNotifications(
  apiBase: string,
  token: string | null,
  connectionId: string | null,
  enabled: boolean,
): QuickInputNotice | null {
  const [notice, setNotice] = useState<{ connectionId: string; value: QuickInputNotice } | null>(null);
  useEffect(() => {
    if (!enabled || !token || !connectionId) return;
    const storageKey = `runweave:quick-input-notices:${connectionId}`;
    const initial = Date.now() - 300_000;
    let saved: { since: string; seen: string[] } = {
      since: new Date(initial).toISOString(), seen: [],
    };
    try {
      const value = localStorage.getItem(storageKey);
      if (value) {
        const parsed = JSON.parse(value) as typeof saved;
        if (Number.isFinite(Date.parse(parsed.since)) && Array.isArray(parsed.seen)) saved = parsed;
      }
    } catch { /* Keep the current window. */ }
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const seen = new Set(saved.seen);
        let latest = saved.since;
        let cursor: string | undefined;
        const fresh: ScheduledRun[] = [];
        do {
          const page = await scheduledTasksApi(apiBase, token).quickInputRuns({
            source: "quick-input", finishedSince: saved.since,
            cursor, limit: 100,
          });
          if (stopped) return;
          for (const run of page.items) {
            if (run.finishedAt && run.finishedAt > latest) latest = run.finishedAt;
            const resultKey = run.resultRevision ? `${run.id}:${run.resultRevision}` : run.id;
            if (!seen.has(resultKey) && ["completed", "failed"].includes(run.status)) {
              seen.add(resultKey);
              fresh.push(run);
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (stopped) return;
        saved = {
          since: new Date(Math.max(initial, Date.parse(latest) - 10_000)).toISOString(),
          seen: [...seen].slice(-500),
        };
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* unavailable */ }
        for (const run of fresh) {
          const notification = noticeFor(run);
          const shown = await window.electronAPI?.showScheduledRunNotification?.({
            connectionId, runId: run.id,
            title: notification.title, body: notification.body,
          }).catch(() => false);
          if (!shown && !stopped) setNotice({ connectionId, value: notification });
        }
      } catch { /* Retry the same finishedAt window on the next pass. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [apiBase, token, connectionId, enabled]);
  return notice?.connectionId === connectionId ? notice.value : null;
}
