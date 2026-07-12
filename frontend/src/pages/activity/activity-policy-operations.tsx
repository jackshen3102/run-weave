import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ActivityOperationAction,
  ActivityDeleteJobDto,
  ActivityOperationScope,
} from "@runweave/shared/activity";
import { Button } from "../../components/ui/button";
import {
  executeActivityOperation,
  fetchActivityDeleteJob,
} from "../../services/activity";

export function ActivityPolicyOperations({ apiBase, token }: { apiBase: string; token: string }) {
  const [scopeType, setScopeType] = useState<"project" | "thread">("project");
  const [scopeId, setScopeId] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const deleteJobQuery = useQuery({
    queryKey: ["activity", "delete-job", apiBase, deleteJobId],
    queryFn: () => fetchActivityDeleteJob(apiBase, token, deleteJobId as string),
    enabled: Boolean(deleteJobId),
    refetchInterval: (query) =>
      query.state.data?.status === "completed" ? false : 1_000,
  });
  const operation = useMutation({
    mutationFn: async (action: ActivityOperationAction) => {
      const id = scopeId.trim();
      if (!id) throw new Error("Enter a scope ID");
      const scope: ActivityOperationScope = scopeType === "project"
        ? { projectId: id }
        : { threadId: id };
      return executeActivityOperation(apiBase, token, action, scope);
    },
    onSuccess: (nextResult) => {
      setResult(nextResult);
      const deleteJob = nextResult as Partial<ActivityDeleteJobDto>;
      if (typeof deleteJob.deleteJobId === "string") {
        setDeleteJobId(deleteJob.deleteJobId);
      }
    },
  });

  return (
    <section className="mt-5 rounded-xl border border-border/70 bg-card/70 p-5">
      <h2 className="font-semibold">Export or delete a scope</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        <select className="h-9 rounded-lg border border-border bg-background px-3 text-sm" value={scopeType} onChange={(event) => setScopeType(event.target.value as "project" | "thread")}>
          <option value="project">Project</option>
          <option value="thread">Thread</option>
        </select>
        <input className="h-9 min-w-72 flex-1 rounded-lg border border-border bg-background px-3 text-sm" value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder={`${scopeType} ID`} />
        <Button variant="outline" onClick={() => operation.mutate("export")} disabled={operation.isPending}>Export</Button>
        <Button variant="destructive" onClick={() => operation.mutate("delete")} disabled={operation.isPending}>Delete</Button>
      </div>
      {operation.isError ? <p className="mt-3 text-sm text-destructive">{operation.error.message}</p> : null}
      {deleteJobQuery.data ? (
        <div className="mt-4 rounded-lg border border-border bg-background p-4 text-sm">
          <p className="font-medium">Delete job {deleteJobQuery.data.status}</p>
          <p className="mt-2 text-muted-foreground">
            {deleteJobQuery.data.deletedFactCount} / {deleteJobQuery.data.previewFactCount} facts physically deleted
          </p>
          {deleteJobQuery.data.lastErrorCode ? <p className="mt-2 text-destructive">{deleteJobQuery.data.lastErrorCode}</p> : null}
        </div>
      ) : null}
      {result ? <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 text-xs">{JSON.stringify(result, null, 2)}</pre> : null}
    </section>
  );
}
