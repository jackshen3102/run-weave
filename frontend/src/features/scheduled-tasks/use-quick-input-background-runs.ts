import { useMemoizedFn } from "ahooks";
import { useEffect, useState } from "react";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { HttpError } from "../../services/http";
import { scheduledTasksApi } from "../../services/scheduled-tasks";

export function useQuickInputBackgroundRuns(
  apiBase: string,
  token: string,
  projectId: string | null,
  enabled: boolean,
) {
  const [backgroundRuns, setBackgroundRuns] = useState<ScheduledRun[]>([]);
  const [backgroundAvailable, setBackgroundAvailable] = useState(true);
  const upsertBackgroundRun = useMemoizedFn((run: ScheduledRun) => {
    setBackgroundRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor))
      .slice(0, 50));
  });

  useEffect(() => {
    setBackgroundRuns([]);
    if (!enabled || !projectId) return;
    let cancelled = false;
    void scheduledTasksApi(apiBase, token)
      .quickInputRuns({ source: "quick-input", projectId, limit: 50 })
      .then((page) => {
        if (cancelled) return;
        setBackgroundAvailable(true);
        setBackgroundRuns((current) => {
          const fromServer = new Set(page.items.map((item) => item.id));
          return [...page.items, ...current.filter((item) =>
            item.snapshot.projectId === projectId && !fromServer.has(item.id))]
            .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor))
            .slice(0, 50);
        });
      })
      .catch((caught) => {
        if (!cancelled && caught instanceof HttpError && caught.status === 404)
          setBackgroundAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, token, enabled, projectId]);

  useEffect(() => {
    if (!enabled) return;
    const activeIds = backgroundRuns
      .filter((run) => ["queued", "running", "stopping"].includes(run.status))
      .map((run) => run.id);
    if (activeIds.length === 0) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      for (const id of activeIds) {
        void scheduledTasksApi(apiBase, token)
          .run(id)
          .then((run) => { if (!cancelled) upsertBackgroundRun(run); })
          .catch(() => undefined);
      }
    }, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [apiBase, token, enabled, backgroundRuns, upsertBackgroundRun]);

  return { backgroundRuns, upsertBackgroundRun, backgroundAvailable };
}
