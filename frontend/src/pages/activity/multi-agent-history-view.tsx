import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { ChevronRight } from "lucide-react";
import { Button } from "../../components/ui/button";
import { HttpError } from "../../services/http";
import {
  fetchAgentTeamArchive,
  fetchAgentTeamArchives,
} from "../../services/work-history";
import { buildAgentTeamJournal } from "./agent-team-history-model";
import { SourceStatuses } from "./terminal-history-view";
import { WorkHistoryInspector } from "./work-history-inspector";
import { WorkHistoryLayout } from "./work-history-layout";
import {
  selectionKey,
  type WorkHistorySelection,
} from "./work-history-selection";

export function MultiAgentHistoryView({
  apiBase,
  token,
  search,
  selectedRunId,
  selectedEventKey,
  onSelectRun,
  onSelectEvent,
  onSelectEntry,
}: {
  apiBase: string;
  token: string;
  search: string;
  selectedRunId: string | null;
  selectedEventKey: string | null;
  onSelectRun: (runId: string | null) => void;
  onSelectEvent: (eventKey: string | null) => void;
  onSelectEntry: (runId: string, eventKey: string) => void;
}) {
  const [selection, setSelection] = useState<WorkHistorySelection | null>(null);
  const [missingRunId, setMissingRunId] = useState<string | null>(null);
  const listQuery = useInfiniteQuery({
    queryKey: ["work-history", "runs", apiBase, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchAgentTeamArchives(
        apiBase,
        token,
        { search: search || undefined, cursor: pageParam, limit: 50 },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const runs = listQuery.data?.pages.flatMap((page) => page.runs) ?? [];
  const effectiveRunId = selectedRunId ?? runs[0]?.runId ?? null;
  const detailQuery = useInfiniteQuery({
    queryKey: ["work-history", "run", apiBase, effectiveRunId],
    initialPageParam: {} as {
      activityCursor?: string;
      asOfActivityOffset?: number;
    },
    queryFn: ({ pageParam, signal }) =>
      fetchAgentTeamArchive(
        apiBase,
        token,
        effectiveRunId as string,
        pageParam,
        signal,
      ),
    getNextPageParam: (page) =>
      page.facts.nextCursor
        ? {
            activityCursor: page.facts.nextCursor,
            asOfActivityOffset: page.asOfActivityOffset,
          }
        : undefined,
    enabled: Boolean(effectiveRunId),
    retry: false,
  });
  const pages = detailQuery.data?.pages ?? [];
  const firstDetail = pages[0];
  const detail = firstDetail
    ? {
        ...firstDetail,
        facts: {
          ...firstDetail.facts,
          facts: [
            ...new Map(
              pages
                .flatMap((page) => page.facts.facts)
                .map((fact) => [fact.eventId, fact]),
            ).values(),
          ],
          nextCursor: pages.at(-1)?.facts.nextCursor,
        },
        sourceStatus: pages.at(-1)?.sourceStatus ?? firstDetail.sourceStatus,
      }
    : null;
  const journal = detail ? buildAgentTeamJournal(detail) : null;
  const allItems = journal
    ? [
        ...journal.setup,
        ...journal.rounds.flatMap((round) => round.items),
        ...journal.acceptance,
        ...journal.unassigned,
      ]
    : [];
  const urlSelection = allItems.find(
    (item) => selectionKey(item.selection) === selectedEventKey,
  )?.selection;
  const activeSelection =
    selection ??
    urlSelection ??
    (detail ? { type: "run" as const, run: detail.run } : null);

  useEffect(() => setSelection(null), [effectiveRunId]);
  useEffect(() => {
    if (
      selectedRunId &&
      detailQuery.error instanceof HttpError &&
      detailQuery.error.status === 404
    ) {
      setMissingRunId(selectedRunId);
      onSelectRun(null);
    }
  }, [detailQuery.error, onSelectRun, selectedRunId]);

  const selectRun = useMemoizedFn((runId: string) => {
    setMissingRunId(null);
    setSelection(null);
    onSelectEvent(null);
    onSelectRun(runId);
  });
  const selectItem = useMemoizedFn((nextSelection: WorkHistorySelection) => {
    setSelection(nextSelection);
    if (effectiveRunId) {
      onSelectEntry(effectiveRunId, selectionKey(nextSelection));
    }
  });
  const closeInspector = useMemoizedFn(() => {
    setSelection(null);
    onSelectEvent(null);
  });
  const closeMobileDetail = useMemoizedFn(() => {
    setSelection(null);
    onSelectEvent(null);
    onSelectRun(null);
  });
  const loadMore = useMemoizedFn(() => void detailQuery.fetchNextPage());
  const loadMoreRuns = useMemoizedFn(() => void listQuery.fetchNextPage());

  return (
    <WorkHistoryLayout
      inspectorOpen={Boolean(activeSelection && selectedEventKey)}
      onCloseInspector={closeInspector}
      mobileDetailOpen={Boolean(selectedRunId)}
      mobileDetailLabel="Multi-Agent Runs"
      onCloseMobileDetail={closeMobileDetail}
      list={
        <div>
          <div className="border-b border-border/70 p-4">
            <h2 className="font-semibold">Multi-Agent Runs</h2>
            <p className="mt-1 text-xs text-muted-foreground">Archives keyed by Run ID</p>
          </div>
          {runs.length === 0 ? (
            <Empty text={listQuery.isError ? "Run archives are unavailable." : "No Multi-Agent Runs recorded."} />
          ) : (
            <div>
              {runs.map((run) => (
                <article
                  key={run.runId}
                  className={`w-full select-text border-b border-border/70 p-4 ${effectiveRunId === run.runId ? selectedRunId ? "bg-primary/10" : "md:bg-primary/10" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{run.runId}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {run.mode} · {run.workerCount} workers
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Next round index {run.nextRoundIndex}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[0.68rem] text-muted-foreground">{run.status}</span>
                      <button
                        type="button"
                        aria-label={`Open Run ${run.runId}`}
                        className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:h-8 md:w-8"
                        onClick={() => selectRun(run.runId)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
              {listQuery.hasNextPage ? (
                <div className="p-3 text-center">
                  <Button variant="outline" size="sm" onClick={loadMoreRuns}>Load more runs</Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      }
      journal={
        <div className="p-5">
          {missingRunId ? (
            <p className="mb-4 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm">
              Run {missingRunId} no longer exists. Select another archive.
            </p>
          ) : null}
          {detailQuery.isError ? (
            <Empty text="The selected Run no longer exists or is unavailable." />
          ) : !detail || !journal ? (
            <Empty text={effectiveRunId ? "Loading Round Journal…" : "Select a Run."} />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{detail.run.runId}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{detail.run.task}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <p>{detail.run.status}</p>
                  <p className="mt-1">Next round index {detail.run.loop.round}</p>
                </div>
              </div>
              <SourceStatuses values={detail.sourceStatus} />
              <JournalSection title="Setup" items={journal.setup} onSelect={selectItem} />
              {journal.rounds.map((round) => (
                <JournalSection key={round.round} title={`Round ${round.round}`} items={round.items} onSelect={selectItem} />
              ))}
              <JournalSection
                title="Acceptance"
                items={journal.acceptance}
                emptyText="未记录"
                onSelect={selectItem}
              />
              {journal.unassigned.length > 0 ? (
                <JournalSection title="Unassigned events" items={journal.unassigned} onSelect={selectItem} />
              ) : null}
              {detailQuery.hasNextPage ? (
                <div className="mt-4 text-center">
                  <Button variant="outline" onClick={loadMore}>Load more Activity Facts</Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      }
      inspector={
        <WorkHistoryInspector
          apiBase={apiBase}
          token={token}
          selection={activeSelection}
          onClose={closeInspector}
        />
      }
    />
  );
}

function JournalSection({
  title,
  items,
  emptyText,
  onSelect,
}: {
  title: string;
  items: ReturnType<typeof buildAgentTeamJournal>["setup"];
  emptyText?: string;
  onSelect: (selection: WorkHistorySelection) => void;
}) {
  return (
    <section className="mt-6">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {emptyText ?? "No recorded events."}
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="flex select-text items-start justify-between gap-3 rounded-lg border border-border/70 p-4"
            >
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
                {item.selection.type === "fact" ? (
                  <p className="mt-2 text-[0.68rem] text-muted-foreground">
                    {item.round !== null ? `Round ${item.round} · ` : ""}
                    attributionSource={item.attributionSource}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-start gap-2">
                <time className="pt-2 text-xs text-muted-foreground">
                  {new Date(item.occurredAt).toLocaleString()}
                </time>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Open ${item.title} details`}
                  onClick={() => onSelect(item.selection)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>;
}
