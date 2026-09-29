import { ArrowLeft, Play } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { TerminalRuntimeProvider } from "../features/terminal/queries/provider";
import { buildConnectionQueryScope } from "../features/query/connection-query-provider";
import { useTaskNavigation } from "../features/scheduled-tasks/navigation";
import { useRun } from "../features/scheduled-tasks/queries";
import { RequestError } from "../features/scheduled-tasks/presentation";
import { RunRecord } from "../features/scheduled-tasks/task-detail";
import { runDetailsPath } from "../features/scheduled-tasks/run-details-path";

interface Props {
  apiBase: string;
  token: string;
  activeConnectionId: string | null;
  activeConnectionGeneration?: number;
  connectionName?: string;
}

export function BackgroundRunPage(props: Props) {
  const scope = buildConnectionQueryScope({
    apiBase: props.apiBase,
    connectionId: props.activeConnectionId,
    generation: props.activeConnectionGeneration,
  });
  return (
    <TerminalRuntimeProvider
      apiBase={props.apiBase}
      token={props.token}
      activeConnectionId={props.activeConnectionId}
      connectionGeneration={props.activeConnectionGeneration}
    >
      <BackgroundRunContent key={scope} connectionName={props.connectionName} />
    </TerminalRuntimeProvider>
  );
}

function BackgroundRunContent({ connectionName }: { connectionName?: string }) {
  const { runId } = useParams<{ runId: string }>();
  const location = useLocation();
  const { back } = useTaskNavigation();
  const run = useRun(runId ?? null);
  if (run.data && run.data.snapshot.origin?.kind !== "quick-input") {
    return <Navigate to={runDetailsPath(run.data)} replace state={location.state} />;
  }
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={back}>
          <ArrowLeft className="mr-1 h-4 w-4" />返回工作区
        </Button>
        <Play className="h-4 w-4" />
        <h1 className="font-semibold">后台运行</h1>
        <span className="ml-auto text-xs text-muted-foreground">
          {connectionName ?? "当前 Backend"}
        </span>
      </header>
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        <RequestError error={run.error} />
        {run.isPending ? <p>正在加载运行记录…</p> : null}
        {run.isError ? (
          <Button variant="outline" onClick={() => void run.refetch()}>重试</Button>
        ) : null}
        {run.data ? (
          <>
            <h2 className="break-words text-xl font-semibold">{run.data.snapshot.name}</h2>
            <RunRecord key={run.data.id} run={run.data} highlighted />
          </>
        ) : null}
      </div>
    </main>
  );
}
