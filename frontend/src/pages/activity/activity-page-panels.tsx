import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, FileClock, Search } from "lucide-react";
import type {
  ActivityDataPolicyDto,
  ActivityFactDto,
  ActivityRuntimeChannel,
  ActivitySourceDto,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import { terminalPreviewFormatBytes } from "@runweave/shared/terminal-preview-core";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { ActivityPolicyOperations } from "./activity-policy-operations";
import { ACTIVITY_NAVIGATION, type ActivityView } from "./activity-navigation";
import {
  ActivityInteractionCard,
  type ActivityInteraction,
} from "./activity-interactions";

export type { ActivityView } from "./activity-navigation";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function FactRow({
  fact,
  onSelect,
}: {
  fact: ActivityFactDto;
  onSelect?: (fact: ActivityFactDto) => void;
}) {
  const scope =
    fact.scope.threadId ??
    fact.scope.runId ??
    fact.scope.projectId ??
    fact.scope.terminalSessionId ??
    "unlinked";
  return (
    <article className="flex select-text items-start justify-between gap-4 border-b border-border/70 px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-border bg-muted/70 px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground">
            Recorded
          </span>
          <h3 className="truncate text-sm font-semibold text-foreground">
            {fact.eventName}
          </h3>
        </div>
        <p className="mt-2 truncate text-xs text-muted-foreground">{scope}</p>
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
      <div className="flex shrink-0 items-start gap-2">
        <time className="pt-2 text-xs text-muted-foreground">
          {formatTime(fact.occurredAt)}
        </time>
        {onSelect ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={`Open ${fact.eventName} event details`}
            onClick={() => onSelect(fact)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
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
    <aside className="min-h-0 overflow-y-auto border-r border-border/70 bg-card/55 p-4 max-md:overflow-hidden max-md:border-b max-md:border-r-0 max-md:px-3 max-md:py-2">
      <div className="flex items-center gap-3 px-2 py-3 max-md:hidden">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[hsl(var(--primary))] text-sm font-bold text-primary-foreground">
          R
        </div>
        <div>
          <p className="text-xs font-semibold tracking-[0.18em]">RUNWEAVE</p>
          <p className="text-[0.68rem] text-muted-foreground">Activity</p>
        </div>
      </div>
      <nav
        className="mt-6 grid gap-1 max-md:mt-0 max-md:flex max-md:gap-2 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden"
        aria-label="Activity views"
      >
        {(["Work history", "Raw data", "Data"] as const).map((group) => (
          <div key={group} className="mb-3 grid gap-1 max-md:contents">
            <p className="px-3 pb-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground max-md:hidden">
              {group}
            </p>
            {ACTIVITY_NAVIGATION.filter((item) => item.group === group).map(
              (item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={view === item.id ? "page" : undefined}
                    className={`flex h-10 items-center gap-3 whitespace-nowrap rounded-lg px-3 text-left text-sm max-md:shrink-0 ${
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
              },
            )}
          </div>
        ))}
      </nav>
      <div className="mt-8 border-t border-border/70 px-2 pt-4 text-xs text-muted-foreground max-md:hidden">
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
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border/70 px-7 py-3 max-lg:flex-col max-lg:items-stretch max-md:gap-2 max-md:px-4 max-md:py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="max-md:h-10 max-md:w-10 max-md:shrink-0 max-md:p-0"
          onClick={onNavigateHome}
          aria-label="Back home"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          <span className="max-md:sr-only">Home</span>
        </Button>
        <div className="min-w-0">
          <h1 className="font-semibold">Activity</h1>
          <p className="text-xs text-muted-foreground max-md:hidden">
            Terminal sessions, questions, and outcomes
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <label className="flex h-9 min-w-72 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm max-lg:min-w-0 max-lg:flex-1">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search event, Thread, project"
          />
        </label>
        <Select
          value={runtimeChannel || "all"}
          onValueChange={(value) =>
            onRuntimeChannelChange(
              value === "all" ? "" : (value as ActivityRuntimeChannel),
            )
          }
        >
          <SelectTrigger
            className="h-9 w-36 bg-card max-md:w-28"
            aria-label="Runtime"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All runtimes</SelectItem>
              <SelectItem value="stable">Stable</SelectItem>
              <SelectItem value="beta">Beta</SelectItem>
              <SelectItem value="dev">Dev</SelectItem>
              <SelectItem value="external">External</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
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
            Questions and responses grouped by their recorded terminal and
            thread
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
        facts.map((fact) => (
          <FactRow key={fact.eventId} fact={fact} onSelect={onSelectFact} />
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
      <div className="mt-5 flex gap-2 max-sm:flex-col">
        <Select
          value={timelineType}
          onValueChange={(value: ActivityTimelineSelector["type"]) =>
            onTimelineTypeChange(value)
          }
        >
          <SelectTrigger
            className="h-9 w-40 max-sm:w-full"
            aria-label="Timeline type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="interaction">Interaction</SelectItem>
              <SelectItem value="correlation">Correlation</SelectItem>
              <SelectItem value="thread">Thread</SelectItem>
              <SelectItem value="run">Run</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
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
        facts.map((fact) => <FactRow key={fact.eventId} fact={fact} />)
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
                {source.runtimeChannel} · {source.runtimeSurface} ·{" "}
                {source.producerVersion}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                instance {source.producerInstanceId} · boot{" "}
                {source.producerBootId}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.gapRanges.length === 0
                  ? "no observed gap ranges"
                  : source.gapRanges
                      .map(
                        (gap) =>
                          `${gap.firstSequence}-${gap.lastSequence} ${gap.status}${gap.reasonCode ? ` (${gap.reasonCode})` : ""}`,
                      )
                      .join(" · ")}
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
            <span className="tabular-nums">
              {source.highestContiguousSequence}/{source.highestSeenSequence}
            </span>
            <span>{source.openGapCount} gaps</span>
            <span className="text-xs text-muted-foreground">
              {formatTime(source.lastSeenAt)}
            </span>
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
          [
            "Fact retention",
            `${policy?.factRetentionDays ?? 30} days`,
            "Recorded metadata",
          ],
          [
            "Content retention",
            `${policy?.contentRetentionDays ?? 7} days`,
            "Query, response, command and excerpt",
          ],
          [
            "SQLite",
            policy?.journalMode ?? "unavailable",
            policy?.databasePathLabel ?? "Local database",
          ],
          [
            "Database size",
            terminalPreviewFormatBytes(policy?.databaseBytes ?? 0),
            "Computed from the shared database file",
          ],
          [
            "Delete jobs",
            String(policy?.pendingDeleteJobs ?? 0),
            "Pending, running or blocked",
          ],
          [
            "Schema",
            String(policy?.schemaVersion ?? 0),
            "Compatibility major and additive minor",
          ],
        ].map(([label, value, detail]) => (
          <article
            key={label}
            className="rounded-xl border border-border/70 bg-card/70 p-5"
          >
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
