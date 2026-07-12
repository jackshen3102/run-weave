import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
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
import { buildActivityInteractions } from "./activity/activity-interactions";
import {
  ActivityHeader,
  ActivitySidebar,
  FactsPanel,
  PolicyPanel,
  RecentActivityPanel,
  SourcesPanel,
  TimelineFactsList,
  TimelinePanel,
  type ActivityView,
} from "./activity/activity-page-panels";

export function ActivityPage({
  apiBase,
  token,
  onNavigateHome,
}: {
  apiBase: string;
  token: string;
  onNavigateHome: () => void;
}) {
  const [view, setView] = useState<ActivityView>("activity");
  const [search, setSearch] = useState("");
  const [runtimeChannel, setRuntimeChannel] =
    useState<ActivityRuntimeChannel | "">("");
  const [timelineType, setTimelineType] =
    useState<ActivityTimelineSelector["type"]>("thread");
  const [timelineId, setTimelineId] = useState("");
  const [selectedFact, setSelectedFact] = useState<ActivityFactDto | null>(null);
  const [expandedInteractionKey, setExpandedInteractionKey] = useState<string | null | undefined>(undefined);
  const deferredSearch = useDeferredValue(search);
  const deferredTimelineId = useDeferredValue(timelineId.trim());

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
    getNextPageParam: (page) => page.nextCursor
      ? { cursor: page.nextCursor, asOfActivityOffset: page.asOfActivityOffset }
      : undefined,
  });
  const sourcesQuery = useQuery({
    queryKey: ["activity", "sources", apiBase],
    queryFn: () => fetchActivitySources(apiBase, token),
  });
  const policyQuery = useQuery({
    queryKey: ["activity", "policy", apiBase],
    queryFn: () => fetchActivityPolicy(apiBase, token),
  });
  const timelineQuery = useInfiniteQuery({
    queryKey: ["activity", "timeline", apiBase, timelineType, deferredTimelineId],
    initialPageParam: {} as { cursor?: string; asOfActivityOffset?: number },
    queryFn: ({ pageParam }) =>
      fetchActivityTimeline(apiBase, token, {
        type: timelineType,
        id: deferredTimelineId,
      }, {
        limit: 100,
        cursor: pageParam.cursor,
        asOfActivityOffset: pageParam.asOfActivityOffset,
      }),
    getNextPageParam: (page) => page.nextCursor
      ? { cursor: page.nextCursor, asOfActivityOffset: page.asOfActivityOffset }
      : undefined,
    enabled: deferredTimelineId.length > 0,
  });

  const selectView = useMemoizedFn((nextView: ActivityView) => setView(nextView));
  const selectFact = useMemoizedFn((fact: ActivityFactDto) => setSelectedFact(fact));
  const closeFact = useMemoizedFn(() => setSelectedFact(null));
  const updateSearch = useMemoizedFn((value: string) => setSearch(value));
  const updateRuntimeChannel = useMemoizedFn((value: ActivityRuntimeChannel | "") =>
    setRuntimeChannel(value),
  );
  const updateTimelineType = useMemoizedFn((value: ActivityTimelineSelector["type"]) =>
    setTimelineType(value),
  );
  const updateTimelineId = useMemoizedFn((value: string) => setTimelineId(value));
  const toggleInteraction = useMemoizedFn((key: string) => {
    setExpandedInteractionKey((current) => {
      const activeKey = current === undefined ? interactions[0]?.key : current;
      return activeKey === key ? null : key;
    });
  });
  const loadMoreFacts = useMemoizedFn(() => {
    void factsQuery.fetchNextPage();
  });
  const loadMoreTimeline = useMemoizedFn(() => {
    void timelineQuery.fetchNextPage();
  });

  const currentSources = sourcesQuery.data ?? [];
  const currentSourceCount = currentSources.filter(
    (source) =>
      !source.lastErrorCode &&
      source.openGapCount === 0 &&
      source.rejectionCount === 0,
  ).length;
  const facts = factsQuery.data?.pages.flatMap((page) => page.facts) ?? [];
  const interactions = buildActivityInteractions(facts);
  const activeInteractionKey = expandedInteractionKey === undefined
    ? interactions[0]?.key
    : expandedInteractionKey;
  const timelineFacts = timelineQuery.data?.pages.flatMap((page) => page.facts) ?? [];
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

          <div className="p-7">
            {view === "activity" ? (
              <RecentActivityPanel
                apiBase={apiBase}
                token={token}
                interactions={interactions}
                activeInteractionKey={activeInteractionKey}
                isError={factsQuery.isError}
                onToggleInteraction={toggleInteraction}
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
              <ActivityFactDetail apiBase={apiBase} token={token} fact={selectedFact} onClose={closeFact} />
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
              <PolicyPanel apiBase={apiBase} token={token} policy={policyQuery.data} />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
