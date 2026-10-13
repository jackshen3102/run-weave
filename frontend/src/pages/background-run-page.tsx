import { Play } from "lucide-react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { TerminalRuntimeProvider } from "../features/terminal/queries/provider";
import { buildConnectionQueryScope } from "../features/query/connection-query-provider";
import { useRun } from "../features/scheduled-tasks/queries";
import { RequestError } from "../features/scheduled-tasks/presentation";
import { QuickInputRunDetail } from "../features/scheduled-tasks/quick-input-run-panel";
import { useQuickInputBackgroundRuns } from "../features/scheduled-tasks/use-quick-input-background-runs";
import { runDetailsPath } from "../features/scheduled-tasks/run-details-path";

interface Props {
  embedded?: boolean;
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
  const run = useRun(runId ?? null);
  const { upsertBackgroundRun } = useQuickInputBackgroundRuns(false);
  if (run.data && run.data.snapshot.origin?.kind !== "quick-input") {
    return (
      <Navigate to={runDetailsPath(run.data)} replace state={location.state} />
    );
  }
  return (
    <main className="min-h-0 bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-2 py-2 backdrop-blur">
        <Play className="h-4 w-4" />
        <span className="text-xs text-muted-foreground">运行详情</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {connectionName ?? "当前 Backend"}
        </span>
      </header>
      <div className="mx-auto w-full space-y-3 py-3">
        <RequestError error={run.error} />
        {run.isPending ? <p>正在加载运行记录…</p> : null}
        {run.isError ? (
          <Button variant="outline" onClick={() => void run.refetch()}>
            重试
          </Button>
        ) : null}
        {run.data ? (
          <QuickInputRunDetail
            key={run.data.id}
            initial={run.data}
            onUpdate={upsertBackgroundRun}
            onOpened={() => {}}
          />
        ) : null}
      </div>
    </main>
  );
}
