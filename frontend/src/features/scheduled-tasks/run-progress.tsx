import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import {
  useScheduledApi,
  scheduledKeys,
  pollInterval,
  useRefreshTasks,
} from "./queries";
import { RequestError } from "./presentation";

export function RunProgress({ run }: { run: ScheduledRun }) {
  const { api, scope } = useScheduledApi();
  const [cursor, setCursor] = useState<string | undefined>();
  const [text, setText] = useState("");
  const consumed = useRef<unknown>(null);
  const active = ["queued", "running", "stopping"].includes(run.status);
  const refresh = useRefreshTasks();
  const output = useQuery({
    queryKey: [
      ...scheduledKeys.all(scope),
      "output",
      run.id,
      cursor,
      run.outputCursor,
      run.status,
    ],
    queryFn: ({ signal }) => api.output(run.id, cursor, signal),
    refetchInterval: active ? pollInterval : false,
    staleTime: 0,
    gcTime: 0,
  });
  useEffect(() => {
    if (!output.data || consumed.current === output.data) return;
    consumed.current = output.data;
    // Bounded display buffer; complete output remains owned by the Backend.
    if (output.data.text && output.data.nextCursor !== cursor)
      setText((current) => (current + output.data.text).slice(-262144));
    if (output.data.nextCursor && output.data.nextCursor !== cursor)
      setCursor(output.data.nextCursor);
  }, [output.data, cursor]);
  const stop = useMutation({
    mutationFn: () => api.stop(run.id),
    onSettled: () => {
      void refresh();
    },
  });
  return (
    <div className="mt-3 space-y-3">
      <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        {text || (output.isPending ? "正在读取进度…" : "暂无输出")}
      </pre>
      <RequestError error={output.error ?? stop.error} />
      {["queued", "running", "stopping"].includes(run.status) ? (
        <Button
          variant="outline"
          size="sm"
          disabled={stop.isPending || run.status === "stopping"}
          onClick={() => {
            if (
              window.confirm("停止本次运行？已经发生的文件或外部操作不会回滚。")
            )
              stop.mutate();
          }}
        >
          {stop.isPending || run.status === "stopping"
            ? "等待执行进程退出…"
            : "停止本次运行"}
        </Button>
      ) : null}
    </div>
  );
}
