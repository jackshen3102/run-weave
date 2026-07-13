import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { useSearchParams } from "react-router-dom";
import type {
  ActivityFactDto,
  ActivityRuntimeChannel,
  ActivityTimelineSelector,
} from "@runweave/shared/activity";
import {
  fetchActivityFacts,
  fetchActivityPolicy,
  fetchActivitySources,
  fetchActivityTimeline,
} from "../services/activity";
import { ActivityFactDetail } from "./activity/activity-fact-detail";
import {
  ActivityHeader,
  ActivitySidebar,
  FactsPanel,
  PolicyPanel,
  SourcesPanel,
  TimelineFactsList,
  TimelinePanel,
  type ActivityView,
} from "./activity/activity-page-panels";
import { MultiAgentHistoryView } from "./activity/multi-agent-history-view";
import { TerminalHistoryView } from "./activity/terminal-history-view";

const ACTIVITY_VIEWS = new Set<ActivityView>([
  "terminals",
  "runs",
  "facts",
  "timeline",
  "sources",
  "policy",
]);

export function ActivityPage({
  apiBase,
  token,
  onNavigateHome,
}: {
  apiBase: string;
  token: string;
  onNavigateHome: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [runtimeChannel, setRuntimeChannel] =
    useState<ActivityRuntimeChannel | "">("");
  const [timelineType, setTimelineType] =
    useState<ActivityTimelineSelector["type"]>("thread");
  const [timelineId, setTimelineId] = useState("");
  const [selectedFact, setSelectedFact] = useState<ActivityFactDto | null>(null);
  const deferredSearch = useDeferredValue(search);
  const deferredTimelineId = useDeferredValue(timelineId.trim());
  const requestedView = searchParams.get("view");
  const view: ActivityView =
    requestedView && ACTIVITY_VIEWS.has(requestedView as ActivityView)
      ? (requestedView as ActivityView)
      : "terminals";

  const factsQuery = useInfiniteQuery({
    queryKey: ["activity", "facts", apiBase, deferredSearch, runtimeChannel],
    initialPageParam: {} as { cursor?: string; asOfActivityOffset?: number },
    queryFn: ({ pageParam }) =>
      fetchActivityFacts(apiBase, token, {
        limit: 100,
        search: deferredSearch || undefined,
        runtimeChannel: runtimeChannel || undefined,
        cursor: pageParam.cursor,
        asOfActivityOffset: pageParam.asOfActivityOffset,
      }),
    getNextPageParam: (page) =>
      page.nextCursor
        ? {
            cursor: page.nextCursor,
            asOfActivityOffset: page.asOfActivityOffset,
          }
        : undefined,
    enabled: view === "facts",
  });
  const sourcesQuery = useQuery({
    queryKey: ["activity", "sources", apiBase],
    queryFn: () => fetchActivitySources(apiBase, token),
  });
  const policyQuery = useQuery({
    queryKey: ["activity", "policy", apiBase],
    queryFn: () => fetchActivityPolicy(apiBase, token),
    enabled: view === "sources" || view === "policy",
  });
  const timelineQuery = useInfiniteQuery({
    queryKey: [
      "activity",
      "timeline",
      apiBase,
      timelineType,
      deferredTimelineId,
    ],
    initialPageParam: {} as { cursor?: string; asOfActivityOffset?: number },
    queryFn: ({ pageParam }) =>
      fetchActivityTimeline(
        apiBase,
        token,
        { type: timelineType, id: deferredTimelineId },
        {
          limit: 100,
          cursor: pageParam.cursor,
          asOfActivityOffset: pageParam.asOfActivityOffset,
        },
      ),
    getNextPageParam: (page) =>
      page.nextCursor
        ? {
            cursor: page.nextCursor,
            asOfActivityOffset: page.asOfActivityOffset,
          }
        : undefined,
    enabled: view === "timeline" && deferredTimelineId.length > 0,
  });

  const updateParams = useMemoizedFn(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      setSearchParams(next, { replace: true });
    },
  );
  const selectView = useMemoizedFn((nextView: ActivityView) => {
    updateParams({
      view: nextView === "terminals" ? null : nextView,
      terminal: null,
      run: null,
      event: null,
    });
    setSelectedFact(null);
  });
  const selectFact = useMemoizedFn((fact: ActivityFactDto) => setSelectedFact(fact));
  const closeFact = useMemoizedFn(() => setSelectedFact(null));
  const updateSearch = useMemoizedFn((value: string) => setSearch(value));
  const updateRuntimeChannel = useMemoizedFn(
    (value: ActivityRuntimeChannel | "") => setRuntimeChannel(value),
  );
  const updateTimelineType = useMemoizedFn(
    (value: ActivityTimelineSelector["type"]) => setTimelineType(value),
  );
  const updateTimelineId = useMemoizedFn((value: string) => setTimelineId(value));
  const loadMoreFacts = useMemoizedFn(() => void factsQuery.fetchNextPage());
  const loadMoreTimeline = useMemoizedFn(() => void timelineQuery.fetchNextPage());
  const selectTerminal = useMemoizedFn((terminalSessionId: string | null) =>
    updateParams({ terminal: terminalSessionId, run: null, event: null }),
  );
  const selectRun = useMemoizedFn((runId: string | null) =>
    updateParams({ run: runId, terminal: null, event: null }),
  );
  const selectEvent = useMemoizedFn((eventKey: string | null) =>
    updateParams({ event: eventKey }),
  );
  const selectTerminalEvent = useMemoizedFn(
    (terminalSessionId: string, eventKey: string) =>
      updateParams({ terminal: terminalSessionId, run: null, event: eventKey }),
  );
  const selectRunEvent = useMemoizedFn((runId: string, eventKey: string) =>
    updateParams({ run: runId, terminal: null, event: eventKey }),
  );

  const currentSources = sourcesQuery.data ?? [];
  const currentSourceCount = currentSources.filter(
    (source) =>
      !source.lastErrorCode &&
      source.openGapCount === 0 &&
      source.rejectionCount === 0,
  ).length;
  const facts = factsQuery.data?.pages.flatMap((page) => page.facts) ?? [];
  const timelineFacts =
    timelineQuery.data?.pages.flatMap((page) => page.facts) ?? [];
  const timelineComputed = timelineQuery.data?.pages[0]?.computed;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-[220px_minmax(0,1fr)] max-lg:grid-cols-1">
        <ActivitySidebar
          view={view}
          onSelectView={selectView}
          currentSourceCount={currentSourceCount}
          sourceCount={currentSources.length}
        />
        <section className="min-w-0">
          <ActivityHeader
            search={search}
            runtimeChannel={runtimeChannel}
            onNavigateHome={onNavigateHome}
            onSearchChange={updateSearch}
            onRuntimeChannelChange={updateRuntimeChannel}
          />
          <div className={view === "terminals" || view === "runs" ? "p-4" : "p-7"}>
            {view === "terminals" ? (
              <TerminalHistoryView
                apiBase={apiBase}
                token={token}
                search={deferredSearch}
                selectedTerminalId={searchParams.get("terminal")}
                selectedEventKey={searchParams.get("event")}
                onSelectTerminal={selectTerminal}
                onSelectEvent={selectEvent}
                onSelectEntry={selectTerminalEvent}
              />
            ) : null}
            {view === "runs" ? (
              <MultiAgentHistoryView
                apiBase={apiBase}
                token={token}
                search={deferredSearch}
                selectedRunId={searchParams.get("run")}
                selectedEventKey={searchParams.get("event")}
                onSelectRun={selectRun}
                onSelectEvent={selectEvent}
                onSelectEntry={selectRunEvent}
              />
            ) : null}
            {view === "facts" ? (
              <FactsPanel
                facts={facts}
                frozenOffset={factsQuery.data?.pages[0]?.asOfActivityOffset ?? 0}
                isError={factsQuery.isError}
                hasNextPage={factsQuery.hasNextPage}
                isFetchingNextPage={factsQuery.isFetchingNextPage}
                onLoadMore={loadMoreFacts}
                onSelectFact={selectFact}
              />
            ) : null}
            {view === "facts" && selectedFact ? (
              <ActivityFactDetail
                apiBase={apiBase}
                token={token}
                fact={selectedFact}
                onClose={closeFact}
              />
            ) : null}
            {view === "timeline" ? (
              <TimelinePanel
                timelineType={timelineType}
                timelineId={timelineId}
                computed={timelineComputed}
                onTimelineTypeChange={updateTimelineType}
                onTimelineIdChange={updateTimelineId}
              >
                <TimelineFactsList
                  deferredTimelineId={deferredTimelineId}
                  facts={timelineFacts}
                  hasNextPage={timelineQuery.hasNextPage}
                  isFetchingNextPage={timelineQuery.isFetchingNextPage}
                  onLoadMore={loadMoreTimeline}
                />
              </TimelinePanel>
            ) : null}
            {view === "sources" ? (
              <SourcesPanel
                currentSourceCount={currentSourceCount}
                sources={currentSources}
                policy={policyQuery.data}
              />
            ) : null}
            {view === "policy" ? (
              <PolicyPanel
                apiBase={apiBase}
                token={token}
                policy={policyQuery.data}
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
