import { X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { ActivityFactDetail } from "./activity-fact-detail";
import type { WorkHistorySelection } from "./work-history-selection";

export function WorkHistoryInspector({
  apiBase,
  token,
  selection,
  onClose,
}: {
  apiBase: string;
  token: string;
  selection: WorkHistorySelection | null;
  onClose: () => void;
}) {
  if (!selection) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select an event to inspect its recorded details.
      </div>
    );
  }
  if (selection.type === "fact") {
    return (
      <div className="p-4">
        {selection.attributionSource ? (
          <div className="mb-3 rounded-lg border border-border/70 p-3 text-sm">
            <p className="text-xs text-muted-foreground">Round attribution</p>
            <p className="mt-1">
              attributionSource={selection.attributionSource}
              {selection.round != null ? ` · Round ${selection.round}` : ""}
            </p>
          </div>
        ) : null}
        <ActivityFactDetail
          apiBase={apiBase}
          token={token}
          fact={selection.fact}
          onClose={onClose}
        />
      </div>
    );
  }
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {selection.type}
          </p>
          <h2 className="mt-2 font-semibold">{selectionTitle(selection)}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close inspector">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-5">{selectionBody(selection)}</div>
    </div>
  );
}

function selectionTitle(selection: Exclude<WorkHistorySelection, { type: "fact" }>) {
  switch (selection.type) {
    case "terminal":
      return selection.terminal.alias || selection.terminal.terminalSessionId;
    case "thread":
      return selection.thread.thread.threadId;
    case "run":
      return selection.run.runId;
    case "worker":
      return selection.worker.role;
    case "case":
      return selection.acceptanceCase.caseId;
    case "evidence":
      return selection.evidence.label;
  }
}

function selectionBody(selection: Exclude<WorkHistorySelection, { type: "fact" }>) {
  switch (selection.type) {
    case "terminal":
      return (
        <DefinitionList
          values={{
            ID: selection.terminal.terminalSessionId,
            Project: selection.terminal.projectId,
            Status: selection.terminal.status,
            Command: selection.terminal.command,
            Directory: selection.terminal.cwd,
            Created: selection.terminal.createdAt,
            "Last activity": selection.terminal.lastActivityAt,
          }}
        />
      );
    case "thread": {
      const { thread } = selection;
      const detailUpdatedAt =
        thread.detail && "updatedAt" in thread.detail
          ? thread.detail.updatedAt
          : thread.thread.updatedAt;
      return (
        <div>
          <DefinitionList
            values={{
              Provider: thread.thread.agent,
              Availability: thread.availability,
              Status: thread.detail?.status ?? thread.thread.status,
              Updated: detailUpdatedAt,
            }}
          />
          {thread.detail?.turns.length ? (
            <div className="mt-6 grid gap-4">
              {thread.detail.turns.map((turn) => {
                const turnId = "id" in turn ? turn.id : turn.turnId;
                if (!("messages" in turn)) {
                  return (
                    <section key={turnId} className="rounded-lg border border-border/70 p-3">
                      <p className="text-sm font-medium">{turnId}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {turn.status} · {turn.preview || "No preview"}
                      </p>
                    </section>
                  );
                }
                return (
                  <section key={turnId} className="rounded-lg border border-border/70 p-3">
                    <p className="text-sm font-medium">{turnId}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {turn.status} · {turn.itemsView} · {turn.itemCount} items
                    </p>
                    <div className="mt-3 grid gap-2">
                      {turn.messages.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No text messages recorded.</p>
                      ) : (
                        turn.messages.map((message) => (
                          <div key={message.id} className="rounded-md bg-muted/55 p-3 text-sm">
                            <p className="text-[0.68rem] font-medium uppercase text-muted-foreground">
                              {message.role}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap">{message.text}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="mt-5 text-sm text-muted-foreground">
              Thread content is {thread.availability.replaceAll("_", " ")}.
            </p>
          )}
        </div>
      );
    }
    case "run":
      return (
        <DefinitionList
          values={{
            Project: selection.run.projectId,
            Terminal: selection.run.terminalSessionId,
            Phase: selection.run.phase,
            Status: selection.run.status,
            "Next round index": selection.run.loop.round,
            Created: selection.run.createdAt,
            Updated: selection.run.updatedAt,
          }}
        />
      );
    case "worker":
      return (
        <DefinitionList
          values={{
            ID: selection.worker.id,
            Role: selection.worker.role,
            Intent: selection.worker.intent,
            Panel: selection.worker.panelId,
            "tmux pane": selection.worker.tmuxPaneId,
          }}
        />
      );
    case "case":
      return (
        <DefinitionList
          values={{
            Status: selection.acceptanceCase.status,
            Conclusion: selection.acceptanceCase.resultSummary ?? "未记录",
            Source: selection.acceptanceCase.sourceFilePath,
            Evidence: selection.acceptanceCase.evidence.length,
          }}
        />
      );
    case "evidence":
      return (
        <DefinitionList
          values={{
            Case: selection.caseId,
            Type: selection.evidence.type,
            Summary: selection.evidence.summary,
            Reference: selection.evidence.ref,
            Detail: selection.evidence.detail,
          }}
        />
      );
  }
}

function DefinitionList({
  values,
}: {
  values: Record<string, string | number | null | undefined>;
}) {
  return (
    <dl className="grid gap-4 text-sm">
      {Object.entries(values).map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words">{value ?? "Not recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}
