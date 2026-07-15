import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { ChevronRight } from "lucide-react";
import type { WorkHistorySourceStatus } from "@runweave/shared/work-history";
import { Button } from "../../components/ui/button";
import { HttpError } from "../../services/http";
import {
  fetchTerminalArchive,
  fetchTerminalArchives,
} from "../../services/work-history";
import { buildTerminalJournal } from "./terminal-history-model";
import { WorkHistoryInspector } from "./work-history-inspector";
import { WorkHistoryLayout } from "./work-history-layout";
import {
  selectionKey,
  type WorkHistorySelection,
} from "./work-history-selection";

interface DetailPageParam {
  activityCursor?: string;
  asOfActivityOffset?: number;
  threadCursor?: string;
  includeActivity?: boolean;
  includeThreadDetails?: boolean;
  pendingActivityCursor?: string;
}

export function TerminalHistoryView({
  apiBase,
  token,
  search,
  selectedTerminalId,
  selectedEventKey,
  onSelectTerminal,
  onSelectEvent,
  onSelectEntry,
}: {
  apiBase: string;
  token: string;
  search: string;
  selectedTerminalId: string | null;
  selectedEventKey: string | null;
  onSelectTerminal: (terminalSessionId: string | null) => void;
  onSelectEvent: (eventKey: string | null) => void;
  onSelectEntry: (terminalSessionId: string, eventKey: string) => void;
}) {
  const [selection, setSelection] = useState<WorkHistorySelection | null>(null);
  const [missingTerminalId, setMissingTerminalId] = useState<string | null>(null);
  const listQuery = useInfiniteQuery({
    queryKey: ["work-history", "terminals", apiBase, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchTerminalArchives(
        apiBase,
        token,
        { search: search || undefined, cursor: pageParam, limit: 50 },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
  const terminals = listQuery.data?.pages.flatMap((page) => page.terminals) ?? [];
  const effectiveTerminalId = selectedTerminalId ?? terminals[0]?.terminalSessionId ?? null;
  const detailQuery = useInfiniteQuery({
    queryKey: ["work-history", "terminal", apiBase, effectiveTerminalId],
    initialPageParam: {} as DetailPageParam,
    queryFn: ({ pageParam, signal }) =>
      fetchTerminalArchive(
        apiBase,
        token,
        effectiveTerminalId as string,
        {
          activityCursor: pageParam.activityCursor,
          asOfActivityOffset: pageParam.asOfActivityOffset,
          threadCursor: pageParam.threadCursor,
          includeActivity: pageParam.includeActivity,
          includeThreadDetails: pageParam.includeThreadDetails,
        },
        signal,
      ),
    getNextPageParam: (page, _pages, pageParam) => {
      const pendingActivityCursor =
        pageParam.pendingActivityCursor ?? page.facts.nextCursor;
      if (page.nextThreadCursor) {
        return {
          threadCursor: page.nextThreadCursor,
          includeActivity: false,
          pendingActivityCursor,
          asOfActivityOffset:
            pageParam.asOfActivityOffset ?? page.asOfActivityOffset,
        } satisfies DetailPageParam;
      }
      if (pendingActivityCursor) {
        return {
          activityCursor: pendingActivityCursor,
          asOfActivityOffset:
            pageParam.asOfActivityOffset ?? page.asOfActivityOffset,
          includeThreadDetails: false,
        } satisfies DetailPageParam;
      }
      return undefined;
    },
    enabled: Boolean(effectiveTerminalId),
    retry: false,
  });
  const pages = detailQuery.data?.pages ?? [];
  const firstDetail = pages[0];
  const detail = firstDetail
    ? {
        ...firstDetail,
        threadDetails: uniqueBy(
          pages.flatMap((page) => page.threadDetails),
          (item) => item.thread.threadId,
        ),
        facts: {
          ...firstDetail.facts,
          facts: uniqueBy(
            pages.flatMap((page) => page.facts.facts),
            (item) => item.eventId,
          ),
          nextCursor: pages.at(-1)?.facts.nextCursor,
        },
        nextThreadCursor: pages.at(-1)?.nextThreadCursor,
        sourceStatus: {
          ...firstDetail.sourceStatus,
          appServer: pages.at(-1)?.sourceStatus.appServer ?? firstDetail.sourceStatus.appServer,
          activity:
            pages.findLast((page) => page.facts.facts.length > 0)?.sourceStatus.activity ??
            firstDetail.sourceStatus.activity,
        },
      }
    : null;
  const journal = detail ? buildTerminalJournal(detail) : [];
  const urlSelection = journal.find(
    (entry) => selectionKey(entry.selection) === selectedEventKey,
  )?.selection;
  const activeSelection =
    selection ??
    urlSelection ??
    (detail ? { type: "terminal" as const, terminal: detail.terminal } : null);

  useEffect(() => {
    setSelection(null);
  }, [effectiveTerminalId]);
  useEffect(() => {
    if (
      selectedTerminalId &&
      detailQuery.error instanceof HttpError &&
      detailQuery.error.status === 404
    ) {
      setMissingTerminalId(selectedTerminalId);
      onSelectTerminal(null);
    }
  }, [detailQuery.error, onSelectTerminal, selectedTerminalId]);

  const selectTerminal = useMemoizedFn((terminalSessionId: string) => {
    setMissingTerminalId(null);
    setSelection(null);
    onSelectEvent(null);
    onSelectTerminal(terminalSessionId);
  });
  const selectEntry = useMemoizedFn((nextSelection: WorkHistorySelection) => {
    setSelection(nextSelection);
    if (effectiveTerminalId) {
      onSelectEntry(effectiveTerminalId, selectionKey(nextSelection));
    }
  });
  const closeInspector = useMemoizedFn(() => {
    setSelection(null);
    onSelectEvent(null);
  });
  const closeMobileDetail = useMemoizedFn(() => {
    setSelection(null);
    onSelectEvent(null);
    onSelectTerminal(null);
  });
  const loadMore = useMemoizedFn(() => {
    void detailQuery.fetchNextPage();
  });
  const loadMoreArchives = useMemoizedFn(() => {
    void listQuery.fetchNextPage();
  });

  return (
    <WorkHistoryLayout
      inspectorOpen={Boolean(activeSelection && selectedEventKey)}
      onCloseInspector={closeInspector}
      mobileDetailOpen={Boolean(selectedTerminalId)}
      mobileDetailLabel="Terminal History"
      onCloseMobileDetail={closeMobileDetail}
      list={
        <div>
          <div className="border-b border-border/70 p-4">
            <h2 className="font-semibold">Terminal History</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              One archive per terminal session
            </p>
          </div>
          {listQuery.isError ? (
            <EmptyState text="Terminal archives are unavailable." />
          ) : terminals.length === 0 ? (
            <EmptyState text="No Terminal history recorded." />
          ) : (
            <div>
              {terminals.map((terminal) => (
                <article
                  key={terminal.terminalSessionId}
                  className={`w-full select-text border-b border-border/70 p-4 ${effectiveTerminalId === terminal.terminalSessionId ? selectedTerminalId ? "bg-primary/10" : "md:bg-primary/10" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{terminal.title}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {terminal.projectId}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {terminal.knownThreadCount} known Threads · {formatTime(terminal.lastActivityAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[0.68rem] text-muted-foreground">{terminal.status}</span>
                      <button
                        type="button"
                        aria-label={`Open ${terminal.title} Terminal archive`}
                        className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:h-8 md:w-8"
                        onClick={() => selectTerminal(terminal.terminalSessionId)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
              {listQuery.hasNextPage ? (
                <div className="p-3 text-center">
                  <Button variant="outline" size="sm" onClick={loadMoreArchives}>
                    Load more terminals
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      }
      journal={
        <div className="p-5">
          {missingTerminalId ? (
            <p className="mb-4 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm">
              Terminal {missingTerminalId} no longer exists. Select another archive.
            </p>
          ) : null}
          {detailQuery.isError ? (
            <EmptyState text="The selected Terminal no longer exists or is unavailable." />
          ) : !detail ? (
            <EmptyState text={effectiveTerminalId ? "Loading Terminal journal…" : "Select a Terminal."} />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {detail.terminal.alias || detail.terminal.terminalSessionId}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">{detail.terminal.cwd}</p>
                </div>
                <span className="rounded-full border border-border px-2 py-1 text-xs">
                  {detail.terminal.status}
                </span>
              </div>
              <SourceStatuses values={detail.sourceStatus} />
              <div className="mt-5 grid gap-3">
                {journal.map((entry) => (
                  <article
                    key={entry.id}
                    className="flex select-text items-start justify-between gap-3 rounded-lg border border-border/70 p-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{entry.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {entry.summary}
                      </p>
                      <p className="mt-2 text-[0.68rem] text-muted-foreground">
                        {entry.sourceType} · {entry.sourceId}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-start gap-2">
                      <time className="pt-2 text-xs text-muted-foreground">
                        {formatTime(entry.occurredAt)}
                      </time>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Open ${entry.title} details`}
                        onClick={() => selectEntry(entry.selection)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              {detailQuery.hasNextPage ? (
                <div className="mt-4 text-center">
                  <Button variant="outline" onClick={loadMore} disabled={detailQuery.isFetchingNextPage}>
                    {detail.nextThreadCursor ? "Load more Threads" : "Load more Activity Facts"}
                  </Button>
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

export function SourceStatuses({
  values,
}: {
  values: Record<string, WorkHistorySourceStatus>;
}) {
  const degraded = Object.entries(values).filter(([, value]) => value.status !== "available");
  if (degraded.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      {degraded.map(([source, status]) => (
        <p key={source}>
          <span className="font-medium">{source}</span>: {status.status}
          {"reason" in status ? ` · ${status.reason}` : ""}
        </p>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
