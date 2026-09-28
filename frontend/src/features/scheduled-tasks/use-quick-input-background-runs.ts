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
  const [backgroundRun, setBackgroundRun] = useState<ScheduledRun | null>(null);
  const [backgroundAvailable, setBackgroundAvailable] = useState(true);

  useEffect(() => {
    if (!enabled || !projectId) return;
    let cancelled = false;
    void scheduledTasksApi(apiBase, token)
      .quickInputRuns({ source: "quick-input", projectId, limit: 1 })
      .then((page) => {
        if (cancelled) return;
        setBackgroundAvailable(true);
        setBackgroundRun((current) =>
          current?.snapshot.projectId === projectId &&
            (!page.items[0] || current.scheduledFor >= page.items[0].scheduledFor)
            ? current
            : page.items[0] ?? null,
        );
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
    if (
      !enabled ||
      !backgroundRun ||
      !["queued", "running", "stopping"].includes(backgroundRun.status)
    ) return;
    const timer = window.setInterval(() => {
      void scheduledTasksApi(apiBase, token)
        .run(backgroundRun.id)
        .then(setBackgroundRun)
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [apiBase, token, enabled, backgroundRun]);

  return { backgroundRun, setBackgroundRun, backgroundAvailable };
}
