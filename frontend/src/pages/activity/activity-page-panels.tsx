import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Clock3,
  Database,
  FileClock,
  Search,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type {
  ActivityDataPolicyDto,
  ActivityFactDto,
  ActivityRuntimeChannel,
  ActivitySourceDto,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import { Button } from "../../components/ui/button";
import { ActivityPolicyOperations } from "./activity-policy-operations";
import {
  ActivityInteractionCard,
  type ActivityInteraction,
} from "./activity-interactions";

export type ActivityView = "activity" | "facts" | "timeline" | "sources" | "policy";

const NAVIGATION: Array<{
  id: ActivityView;
  label: string;
  icon: typeof Activity;
}> = [
  { id: "activity", label: "Activity", icon: Activity },
  { id: "facts", label: "Events", icon: Database },
  { id: "timeline", label: "Timeline", icon: Clock3 },
  { id: "sources", label: "Sources", icon: Unplug },
  { id: "policy", label: "Data Policy", icon: ShieldCheck },
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function FactRow({ fact, onSelect }: { fact: ActivityFactDto; onSelect?: (fact: ActivityFactDto) => void }) {
  const scope =
    fact.scope.threadId ??
    fact.scope.runId ??
    fact.scope.projectId ??
    fact.scope.terminalSessionId ??
    "unlinked";
  return (
    <article className="border-b border-border/70 px-5 py-4 last:border-b-0">
      <button type="button" className="w-full text-left" onClick={() => onSelect?.(fact)}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-muted/70 px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground">
                Recorded
              </span>
              <h3 className="truncate text-sm font-semibold text-foreground">
                {fact.eventName}
              </h3>
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {scope}
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-[0.68rem] text-muted-foreground">
              <span className="rounded-full border border-border/70 px-2 py-1">
                {fact.runtime.channel}
              </span>
              <span className="rounded-full border border-border/70 px-2 py-1">
                {fact.runtime.surface}
              </span>
              <span className="rounded-full border border-border/70 px-2 py-1">
                offset {fact.activityOffset}
              </span>
            </div>
          </div>
          <time className="shrink-0 text-xs text-muted-foreground">
            {formatTime(fact.occurredAt)}
          </time>
        </div>
      </button>
    </article>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="flex min-h-56 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function ActivitySidebar({
  view,
  onSelectView,
  currentSourceCount,
  sourceCount,
}: {
  view: ActivityView;
  onSelectView: (view: ActivityView) => void;
  currentSourceCount: number;
  sourceCount: number;
}) {
  return (
    <aside className="border-r border-border/70 bg-card/55 p-4 max-lg:border-b max-lg:border-r-0">
      <div className="flex items-center gap-3 px-2 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[hsl(var(--primary))] text-sm font-bold text-primary-foreground">
          R
        </div>
        <div>
          <p className="text-xs font-semibold tracking-[0.18em]">RUNWEAVE</p>
          <p className="text-[0.68rem] text-muted-foreground">Activity</p>
        </div>
      </div>
      <nav className="mt-6 grid gap-1" aria-label="Activity views">
        {NAVIGATION.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`flex h-10 items-center gap-3 rounded-lg px-3 text-left text-sm ${
                view === item.id
                  ? "bg-[hsl(var(--primary))]/12 text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
              onClick={() => onSelectView(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-8 border-t border-border/70 px-2 pt-4 text-xs text-muted-foreground">
        {currentSourceCount} of {sourceCount} sources current
      </div>
    </aside>
  );
}

export function ActivityHeader({
  search,
  runtimeChannel,
  onNavigateHome,
  onSearchChange,
  onRuntimeChannelChange,
}: {
  search: string;
  runtimeChannel: ActivityRuntimeChannel | "";
  onNavigateHome: () => void;
  onSearchChange: (value: string) => void;
  onRuntimeChannelChange: (value: ActivityRuntimeChannel | "") => void;
}) {
  return (
    <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border/70 px-7 py-3 max-md:flex-col max-md:items-stretch">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onNavigateHome}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Home
        </Button>
        <div>
          <h1 className="font-semibold">Activity</h1>
          <p className="text-xs text-muted-foreground">
            Terminal sessions, questions, and outcomes
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <label className="flex h-9 min-w-72 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm max-md:min-w-0 max-md:flex-1">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search event, Thread, project"
          />
        </label>
        <select
          className="h-9 rounded-lg border border-border bg-card px-3 text-sm"
          value={runtimeChannel}
          onChange={(event) =>
            onRuntimeChannelChange(event.target.value as ActivityRuntimeChannel | "")
          }
        >
          <option value="">All runtimes</option>
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
          <option value="dev">Dev</option>
          <option value="external">External</option>
        </select>
      </div>
    </header>
  );
}

export function RecentActivityPanel({
  apiBase,
  token,
  interactions,
  activeInteractionKey,
  isError,
  onToggleInteraction,
}: {
  apiBase: string;
  token: string;
  interactions: ActivityInteraction[];
  activeInteractionKey?: string | null;
  isError: boolean;
  onToggleInteraction: (key: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
        <div>
          <h2 className="font-semibold">Recent activity</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Questions and responses grouped by their recorded terminal and thread
          </p>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {interactions.length} interactions
        </span>
      </div>
      {isError ? (
        <EmptyPanel message="Activity is unavailable." />
      ) : interactions.length === 0 ? (
        <EmptyPanel message="No terminal interactions have been recorded yet." />
      ) : (
        interactions.map((interaction) => (
          <ActivityInteractionCard
            key={interaction.key}
            apiBase={apiBase}
            token={token}
            interaction={interaction}
            expanded={activeInteractionKey === interaction.key}
            onToggle={() => onToggleInteraction(interaction.key)}
          />
        ))
      )}
    </section>
  );
}

export function FactsPanel({
  facts,
  frozenOffset,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onSelectFact,
}: {
  facts: ActivityFactDto[];
  frozenOffset: number;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onSelectFact: (fact: ActivityFactDto) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
        <div>
          <h2 className="font-semibold">Recorded events</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Frozen at offset {frozenOffset}
          </p>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {facts.length} recorded
        </span>
      </div>
      {isError ? (
        <EmptyPanel message="Activity facts are unavailable." />
      ) : facts.length === 0 ? (
        <EmptyPanel message="No recorded facts match these filters." />
      ) : (
        facts.map((fact) => <FactRow key={fact.eventId} fact={fact} onSelect={onSelectFact} />)
      )}
      {hasNextPage ? (
        <div className="border-t border-border/70 p-4 text-center">
          <Button variant="outline" onClick={onLoadMore} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function TimelinePanel({
  timelineType,
  timelineId,
  computed,
  onTimelineTypeChange,
  onTimelineIdChange,
  children,
}: {
  timelineType: ActivityTimelineSelector["type"];
  timelineId: string;
  computed?: { eventCount: number; durationMs?: number };
  onTimelineTypeChange: (value: ActivityTimelineSelector["type"]) => void;
  onTimelineIdChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/70 p-5">
      <h2 className="font-semibold">Interaction Timeline</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Timelines use explicit IDs only; time proximity never creates a link.
      </p>
      {computed ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Computed</span>
          {` · ${computed.eventCount} events`}
          {computed.durationMs !== undefined
            ? ` · ${computed.durationMs} ms duration`
            : ""}
        </p>
      ) : null}
      <div className="mt-5 flex gap-2">
        <select
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          value={timelineType}
          onChange={(event) =>
            onTimelineTypeChange(event.target.value as ActivityTimelineSelector["type"])
          }
        >
          <option value="interaction">Interaction</option>
          <option value="correlation">Correlation</option>
          <option value="thread">Thread</option>
          <option value="run">Run</option>
        </select>
        <input
          className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none"
          value={timelineId}
          onChange={(event) => onTimelineIdChange(event.target.value)}
          placeholder={`Enter ${timelineType} ID`}
        />
      </div>
      {children}
    </section>
  );
}

export function TimelineFactsList({
  deferredTimelineId,
  facts,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  deferredTimelineId: string;
  facts: ActivityFactDto[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  return (
      <div className="mt-5 overflow-hidden rounded-lg border border-border/70">
        {!deferredTimelineId ? (
          <EmptyPanel message="Enter an explicit ID to open a timeline." />
        ) : facts.length === 0 ? (
          <EmptyPanel message="No facts are linked to this ID." />
        ) : (
          facts.map((fact) => (
            <FactRow key={fact.eventId} fact={fact} />
          ))
        )}
        {hasNextPage ? (
          <div className="border-t border-border/70 p-4 text-center">
            <Button
              variant="outline"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
  );
}

export function SourcesPanel({
  currentSourceCount,
  sources,
  policy,
}: {
  currentSourceCount: number;
  sources: ActivitySourceDto[];
  policy?: ActivityDataPolicyDto;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card/70">
      <div className="border-b border-border/70 px-5 py-4">
        <h2 className="font-semibold">Sources</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {currentSourceCount} current of {sources.length} observed sources
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          WAL {policy?.journalMode ?? "unavailable"}
          {policy?.lastCheckpointAt
            ? ` · checkpoint ${policy.lastCheckpointAt}`
            : " · checkpoint not observed"}
        </p>
      </div>
      {sources.length === 0 ? (
        <EmptyPanel message="No producer source has been observed." />
      ) : (
        sources.map((source) => (
          <article
            key={`${source.producerInstanceId}:${source.producerBootId}`}
            className="grid grid-cols-[minmax(0,1fr)_repeat(3,auto)] items-center gap-6 border-b border-border/70 px-5 py-4 text-sm last:border-b-0 max-md:grid-cols-1"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{source.producerName}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {source.runtimeChannel} · {source.runtimeSurface} · {source.producerVersion}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                instance {source.producerInstanceId} · boot {source.producerBootId}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.gapRanges.length === 0
                  ? "no observed gap ranges"
                  : source.gapRanges.map((gap) =>
                      `${gap.firstSequence}-${gap.lastSequence} ${gap.status}${gap.reasonCode ? ` (${gap.reasonCode})` : ""}`,
                    ).join(" · ")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.rejectionCount} rejections
                {source.lastCommitLatencyMs !== undefined
                  ? ` · ${source.lastCommitLatencyMs} ms last commit`
                  : " · latency unavailable"}
                {source.lastErrorCode
                  ? ` · error ${source.lastErrorCode}`
                  : " · no error"}
              </p>
            </div>
            <span className="tabular-nums">{source.highestContiguousSequence}/{source.highestSeenSequence}</span>
            <span>{source.openGapCount} gaps</span>
            <span className="text-xs text-muted-foreground">{formatTime(source.lastSeenAt)}</span>
          </article>
        ))
      )}
    </section>
  );
}

export function PolicyPanel({
  apiBase,
  token,
  policy,
}: {
  apiBase: string;
  token: string;
  policy?: ActivityDataPolicyDto;
}) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[
          ["Fact retention", `${policy?.factRetentionDays ?? 30} days`, "Recorded metadata"],
          ["Content retention", `${policy?.contentRetentionDays ?? 7} days`, "Query, response, command and excerpt"],
          ["SQLite", policy?.journalMode ?? "unavailable", policy?.databasePathLabel ?? "Local database"],
          ["Database size", `${policy?.databaseBytes ?? 0} bytes`, "Computed from the shared database file"],
          ["Delete jobs", String(policy?.pendingDeleteJobs ?? 0), "Pending, running or blocked"],
          ["Schema", String(policy?.schemaVersion ?? 0), "Compatibility major and additive minor"],
        ].map(([label, value, detail]) => (
          <article key={label} className="rounded-xl border border-border/70 bg-card/70 p-5">
            <FileClock className="h-5 w-5 text-muted-foreground" />
            <p className="mt-4 text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
          </article>
        ))}
      </section>
      <ActivityPolicyOperations apiBase={apiBase} token={token} />
    </>
  );
}
