import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDot, Terminal } from "lucide-react";
import type { ActivityFactDto } from "@runweave/shared/activity";
import { fetchActivityContent } from "../../services/activity";

export interface ActivityInteraction {
  key: string;
  facts: ActivityFactDto[];
  query?: ActivityFactDto;
  response?: ActivityFactDto;
  terminalSessionId?: string;
  threadId?: string;
  startedAt: string;
  endedAt?: string;
}

const USER_EVENT_LABELS: Partial<Record<ActivityFactDto["eventName"], string>> = {
  "terminal.session.created": "Terminal opened",
  "agent.thread.started": "Agent conversation started",
  "agent.thread.resumed": "Agent conversation resumed",
  "user.query.submit_requested": "Question submitted",
  "agent.tool.requested": "Tool started",
  "agent.tool.completed": "Tool completed",
  "agent.response.observed": "Response completed",
};

function interactionIdentity(fact: ActivityFactDto): string | null {
  if (fact.scope.interactionId) return `interaction:${fact.scope.interactionId}`;
  return fact.scope.threadId ? `thread:${fact.scope.threadId}` : null;
}

export function buildActivityInteractions(facts: ActivityFactDto[]): ActivityInteraction[] {
  const ordered = [...facts].sort((left, right) => left.activityOffset - right.activityOffset);
  const activeByIdentity = new Map<string, ActivityInteraction>();
  const pendingThreadStart = new Map<string, ActivityFactDto>();
  const pendingTerminalStart = new Map<string, ActivityFactDto>();
  const interactions: ActivityInteraction[] = [];

  for (const fact of ordered) {
    if (fact.eventName === "terminal.session.created" && fact.scope.terminalSessionId) {
      pendingTerminalStart.set(fact.scope.terminalSessionId, fact);
      continue;
    }
    if (
      (fact.eventName === "agent.thread.started" || fact.eventName === "agent.thread.resumed") &&
      fact.scope.threadId
    ) {
      pendingThreadStart.set(fact.scope.threadId, fact);
      continue;
    }

    const identity = interactionIdentity(fact);
    if (!identity) continue;

    if (fact.eventName === "user.query.submit_requested") {
      const interaction: ActivityInteraction = {
        key: fact.scope.interactionId
          ? `interaction:${fact.scope.interactionId}`
          : `${identity}:query:${fact.eventId}`,
        facts: [],
        query: fact,
        terminalSessionId: fact.scope.terminalSessionId,
        threadId: fact.scope.threadId,
        startedAt: fact.occurredAt,
      };
      const terminalStart = fact.scope.terminalSessionId
        ? pendingTerminalStart.get(fact.scope.terminalSessionId)
        : undefined;
      const threadStart = fact.scope.threadId
        ? pendingThreadStart.get(fact.scope.threadId)
        : undefined;
      if (terminalStart) interaction.facts.push(terminalStart);
      if (threadStart) interaction.facts.push(threadStart);
      interaction.facts.push(fact);
      interactions.push(interaction);
      activeByIdentity.set(identity, interaction);
      continue;
    }

    let interaction = activeByIdentity.get(identity);
    if (!interaction && fact.eventName === "agent.response.observed") {
      interaction = {
        key: `${identity}:response:${fact.eventId}`,
        facts: [],
        terminalSessionId: fact.scope.terminalSessionId,
        threadId: fact.scope.threadId,
        startedAt: fact.occurredAt,
      };
      interactions.push(interaction);
    }
    if (!interaction) continue;

    interaction.facts.push(fact);
    if (fact.eventName === "agent.response.observed") {
      interaction.response = fact;
      interaction.endedAt = fact.occurredAt;
      activeByIdentity.delete(identity);
    }
  }

  return interactions.sort((left, right) => {
    const leftOffset = left.facts.at(-1)?.activityOffset ?? 0;
    const rightOffset = right.facts.at(-1)?.activityOffset ?? 0;
    return rightOffset - leftOffset;
  });
}

function decodeContent(bytesBase64?: string): string | null {
  if (!bytesBase64) return null;
  return new TextDecoder().decode(
    Uint8Array.from(atob(bytesBase64), (character) => character.charCodeAt(0)),
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(interaction: ActivityInteraction): string | null {
  if (!interaction.endedAt) return null;
  const durationMs = new Date(interaction.endedAt).getTime() - new Date(interaction.startedAt).getTime();
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${Math.round(durationMs / 1_000)} sec`;
}

function agentLabel(interaction: ActivityInteraction): string {
  const agent = interaction.query?.payload.agent;
  return typeof agent === "string" && agent ? agent : "Agent";
}

function statusLabel(interaction: ActivityInteraction): string {
  const status = interaction.response?.result?.status;
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return interaction.response ? "Completed" : "In progress";
}

function contentDescriptor(fact: ActivityFactDto | undefined, role: "query" | "response") {
  return fact?.contentDescriptors.find((descriptor) => descriptor.role === role);
}

export function ActivityInteractionCard({
  apiBase,
  token,
  interaction,
  expanded,
  onToggle,
}: {
  apiBase: string;
  token: string;
  interaction: ActivityInteraction;
  expanded: boolean;
  onToggle: () => void;
}) {
  const queryDescriptor = contentDescriptor(interaction.query, "query");
  const responseDescriptor = contentDescriptor(interaction.response, "response");
  const queryContent = useQuery({
    queryKey: ["activity", "interaction-query", apiBase, queryDescriptor?.contentId],
    queryFn: () => fetchActivityContent(apiBase, token, queryDescriptor?.contentId as string),
    enabled: expanded && queryDescriptor?.availability === "available",
  });
  const responseContent = useQuery({
    queryKey: ["activity", "interaction-response", apiBase, responseDescriptor?.contentId],
    queryFn: () => fetchActivityContent(apiBase, token, responseDescriptor?.contentId as string),
    enabled: expanded && responseDescriptor?.availability === "available",
  });
  const question = decodeContent(queryContent.data?.bytesBase64);
  const response = decodeContent(responseContent.data?.bytesBase64);
  const status = statusLabel(interaction);
  const duration = formatDuration(interaction);

  return (
    <article className="border-b border-border/70 last:border-b-0">
      <button type="button" className="w-full px-5 py-4 text-left" onClick={onToggle}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Terminal className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="max-w-3xl truncate text-sm font-semibold">
                  {question ?? (queryContent.isPending && expanded ? "Loading question…" : "User request")}
                </h3>
                <span className={`rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${
                  status === "Completed"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : status === "In progress"
                      ? "bg-amber-500/15 text-amber-300"
                      : "bg-destructive/15 text-destructive"
                }`}>
                  {status}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {interaction.terminalSessionId ? `Terminal ${interaction.terminalSessionId}` : "Terminal unavailable"}
                {` · ${agentLabel(interaction)}`}
                {duration ? ` · ${duration}` : ""}
              </p>
            </div>
          </div>
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border/50 bg-muted/15 px-5 py-4">
          <ol className="grid gap-3">
            {interaction.facts.map((fact) => {
              const completed = fact.eventName === "agent.response.observed";
              return (
                <li key={fact.eventId} className="grid grid-cols-[18px_90px_minmax(0,1fr)] items-start gap-2 text-sm">
                  {completed ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> : <CircleDot className="mt-0.5 h-4 w-4 text-muted-foreground" />}
                  <time className="text-xs text-muted-foreground">{formatTime(fact.occurredAt)}</time>
                  <span>{USER_EVENT_LABELS[fact.eventName] ?? fact.eventName}</span>
                </li>
              );
            })}
          </ol>
          {question ? (
            <div className="mt-4 rounded-lg border border-border/70 bg-background/60 p-3">
              <p className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">Question</p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{question}</p>
            </div>
          ) : null}
          {response ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-background/60 p-3">
              <p className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">Response</p>
              <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-sm">{response}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
