import type { ActivityFactsPage } from "@runweave/shared/activity";
import type {
  AppServerThreadDetailResponse,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";
import type {
  AgentTeamArchiveDetail,
  AgentTeamArchivePage,
  AgentTeamArchiveSummary,
  TerminalArchiveDetail,
  TerminalArchivePage,
  TerminalArchiveSummary,
  WorkHistorySourceStatus,
} from "@runweave/shared/work-history";
import type { ActivityQueryService } from "../activity/query-service";
import type { AgentTeamService } from "../agent-team/service";
import type { TerminalSessionManager } from "../terminal/manager";
import { toSessionListItem } from "../terminal/application/payloads";
import {
  AppServerHistoryGatewayError,
  type AppServerHistoryGateway,
} from "./app-server-history-gateway";

const APP_SERVER_PAGE_LIMIT = 500;
const MAX_APP_SERVER_PAGES = 100;
const DEFAULT_FACTS_LIMIT = 200;
const DEFAULT_THREAD_DETAIL_LIMIT = 50;
const THREAD_DETAIL_CONCURRENCY = 4;

type ListOptions = { search?: string; cursor?: string; limit: number };

export interface TerminalDetailOptions {
  activityCursor?: string;
  asOfActivityOffset?: number;
  threadCursor?: string;
  includeActivity?: boolean;
  includeThreadDetails?: boolean;
}

export interface RunDetailOptions {
  activityCursor?: string;
  asOfActivityOffset?: number;
}

export class WorkHistoryService {
  constructor(
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly activityQueryService: ActivityQueryService,
    private readonly appServerGateway: AppServerHistoryGateway,
    private readonly agentTeamService: AgentTeamService,
  ) {}

  async listTerminals(options: ListOptions): Promise<TerminalArchivePage> {
    const sessions = this.terminalSessionManager.listSessions();
    let threads: AppServerThreadRef[] = [];
    let appServerStatus: WorkHistorySourceStatus = { status: "available" };
    try {
      threads = await this.listAllThreads();
    } catch {
      appServerStatus = {
        status: "unavailable",
        reason: "App Server thread references are unavailable.",
      };
    }
    const threadCounts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.terminalSessionId) {
        threadCounts.set(
          thread.terminalSessionId,
          (threadCounts.get(thread.terminalSessionId) ?? 0) + 1,
        );
      }
    }
    const projects = new Map(
      this.terminalSessionManager
        .listAllProjectContexts()
        .map((project) => [project.id, project]),
    );
    const search = options.search?.trim().toLowerCase() ?? "";
    const summaries = sessions
      .map<TerminalArchiveSummary>((session) => ({
        terminalSessionId: session.id,
        projectId: session.projectId,
        title:
          session.alias?.trim() ||
          projects.get(session.projectId)?.name ||
          this.terminalSessionManager.getProjectContext(session.projectId)?.name ||
          session.command ||
          session.id,
        cwd: session.cwd,
        command: session.command,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        ...(session.lastThreadId
          ? {
              lastThread: {
                threadId: session.lastThreadId,
                provider: session.lastThreadProvider ?? "unknown",
                status: session.lastThreadStatus,
                updatedAt: session.lastThreadUpdatedAt?.toISOString(),
              },
            }
          : {}),
        knownThreadCount: threadCounts.get(session.id) ?? 0,
      }))
      .filter((summary) =>
        !search
          ? true
          : [
              summary.title,
              summary.terminalSessionId,
              summary.projectId,
              projects.get(summary.projectId)?.name,
              this.terminalSessionManager.getProjectContext(summary.projectId)
                ?.name,
              summary.cwd,
              summary.command,
            ].some((value) => value?.toLowerCase().includes(search)),
      )
      .sort(compareTerminalSummaries);
    const cursor = decodeCursor(options.cursor, "terminals");
    const remaining = cursor
      ? summaries.filter((summary) =>
          compareTerminalTuple(
            summary,
            cursor.at,
            cursor.id,
          ) > 0,
        )
      : summaries;
    const terminals = remaining.slice(0, options.limit);
    const last = terminals.at(-1);
    return {
      terminals,
      ...(remaining.length > terminals.length && last
        ? {
            nextCursor: encodeCursor({
              kind: "terminals",
              at: last.lastActivityAt,
              id: last.terminalSessionId,
            }),
          }
        : {}),
      sourceStatus: {
        terminal: { status: "available" },
        appServer: appServerStatus,
      },
    };
  }

  async getTerminal(
    terminalSessionId: string,
    options: TerminalDetailOptions = {},
  ): Promise<TerminalArchiveDetail | null> {
    const session = this.terminalSessionManager.getSession(terminalSessionId);
    if (!session) {
      return null;
    }
    let threadRefs: AppServerThreadRef[] = [];
    let appServerStatus: WorkHistorySourceStatus = { status: "available" };
    try {
      threadRefs = (await this.listAllThreads({ terminalSessionId })).sort(
        compareThreadRefs,
      );
    } catch {
      appServerStatus = {
        status: "unavailable",
        reason: "App Server thread references are unavailable.",
      };
    }

    const threadOffset = decodeOffsetCursor(options.threadCursor, "threads");
    const selectedThreadRefs = options.includeThreadDetails === false
      ? []
      : threadRefs.slice(
          threadOffset,
          threadOffset + DEFAULT_THREAD_DETAIL_LIMIT,
        );
    const threadDetails = await mapConcurrent(
      selectedThreadRefs,
      THREAD_DETAIL_CONCURRENCY,
      async (thread): Promise<AppServerThreadDetailResponse> => {
        try {
          return await this.appServerGateway.getThreadDetail(thread.threadId);
        } catch (error) {
          return {
            thread,
            availability:
              error instanceof AppServerHistoryGatewayError &&
              error.code === "thread_not_found"
                ? "thread_not_found"
                : "provider_unavailable",
          };
        }
      },
    );
    const nextThreadOffset = threadOffset + selectedThreadRefs.length;
    const nextThreadCursor =
      options.includeThreadDetails !== false && nextThreadOffset < threadRefs.length
        ? encodeCursor({ kind: "threads", offset: nextThreadOffset })
        : undefined;
    if (
      appServerStatus.status === "available" &&
      (nextThreadCursor ||
        threadDetails.some(
          (detail) => detail.availability === "provider_unavailable",
        ))
    ) {
      appServerStatus = {
        status: "partial",
        reason: nextThreadCursor
          ? `${threadRefs.length - nextThreadOffset} Thread details remain unloaded.`
          : "Some Thread details are unavailable.",
      };
    }

    const activity = await this.readFacts(
      options.includeActivity === false
        ? null
        : {
            terminalSessionId,
            cursor: options.activityCursor,
            asOfActivityOffset: options.asOfActivityOffset,
            limit: DEFAULT_FACTS_LIMIT,
          },
    );
    return {
      terminal: toSessionListItem(session),
      threadRefs,
      threadDetails,
      ...(nextThreadCursor ? { nextThreadCursor } : {}),
      facts: activity.page,
      asOfActivityOffset: activity.page.asOfActivityOffset,
      sourceStatus: {
        terminal: { status: "available" },
        activity: activity.status,
        appServer: appServerStatus,
        scrollback: { status: "available" },
      },
    };
  }

  async listRuns(options: ListOptions): Promise<AgentTeamArchivePage> {
    const projectIds = this.terminalSessionManager
      .listAllProjectContexts()
      .map((project) => project.id);
    const runs = (
      await Promise.all(
        projectIds.map((projectId) => this.agentTeamService.listRuns(projectId)),
      )
    ).flat();
    const search = options.search?.trim().toLowerCase() ?? "";
    const summaries = runs
      .map<AgentTeamArchiveSummary>((run) => ({
        runId: run.runId,
        projectId: run.projectId,
        terminalSessionId: run.terminalSessionId,
        runKind: run.runKind ?? "primary",
        ownerRunId: run.lineage?.ownerRunId ?? null,
        ownerDispatchId: run.lineage?.ownerDispatchId ?? null,
        status: run.status,
        mode: run.options.autoApproveSplit ? "automatic" : "manual",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        workerCount: run.workers.length,
        nextRoundIndex: run.loop.round,
      }))
      .filter((summary) =>
        !search
          ? true
          : [
              summary.runId,
              summary.projectId,
              summary.terminalSessionId,
              summary.runKind,
              summary.ownerRunId ?? "",
              summary.ownerDispatchId ?? "",
              summary.status,
            ].some((value) => value.toLowerCase().includes(search)),
      )
      .sort(compareRunSummaries);
    const cursor = decodeCursor(options.cursor, "runs");
    const cursorWithGroup =
      cursor && !cursor.group
        ? {
            ...cursor,
            group: summaries.find(
              (summary) =>
                summary.runId === cursor.id && summary.updatedAt === cursor.at,
            )?.runKind,
          }
        : cursor;
    const remaining = cursorWithGroup
      ? summaries.filter(
          (summary) => compareRunCursor(summary, cursorWithGroup) > 0,
        )
      : summaries;
    const pageRuns = remaining.slice(0, options.limit);
    const last = pageRuns.at(-1);
    return {
      runs: pageRuns,
      ...(remaining.length > pageRuns.length && last
        ? {
            nextCursor: encodeCursor({
              kind: "runs",
              group: last.runKind,
              at: last.updatedAt,
              id: last.runId,
            }),
          }
        : {}),
      sourceStatus: { run: { status: "available" } },
    };
  }

  async getRun(
    runId: string,
    options: RunDetailOptions = {},
  ): Promise<AgentTeamArchiveDetail | null> {
    const run = await this.agentTeamService.getRun(runId);
    if (!run) {
      return null;
    }
    const activity = await this.readFacts({
      runId,
      cursor: options.activityCursor,
      asOfActivityOffset: options.asOfActivityOffset,
      limit: DEFAULT_FACTS_LIMIT,
    });
    return {
      run,
      facts: activity.page,
      asOfActivityOffset: activity.page.asOfActivityOffset,
      sourceStatus: {
        run: { status: "available" },
        activity: activity.status,
      },
    };
  }

  private async listAllThreads(
    filters: { terminalSessionId?: string } = {},
  ): Promise<AppServerThreadRef[]> {
    const threads = new Map<string, AppServerThreadRef>();
    let after: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_APP_SERVER_PAGES; pageIndex += 1) {
      const page = await this.appServerGateway.listThreads({
        ...filters,
        after,
        limit: APP_SERVER_PAGE_LIMIT,
      });
      for (const thread of page.threads) {
        threads.set(thread.threadId, thread);
      }
      if (page.threads.length < APP_SERVER_PAGE_LIMIT) {
        break;
      }
      const nextAfter = page.threads.at(-1)?.lastEventId ?? null;
      if (!nextAfter || nextAfter === after) {
        break;
      }
      after = nextAfter;
    }
    return [...threads.values()];
  }

  private async readFacts(
    query: Parameters<ActivityQueryService["facts"]>[0] | null,
  ): Promise<{ page: ActivityFactsPage; status: WorkHistorySourceStatus }> {
    if (!query) {
      return {
        page: { facts: [], asOfActivityOffset: 0 },
        status: { status: "available" },
      };
    }
    try {
      const page = await this.activityQueryService.facts(query);
      return {
        page,
        status: page.nextCursor
          ? { status: "partial", reason: "More Activity Facts are available." }
          : { status: "available" },
      };
    } catch {
      return {
        page: {
          facts: [],
          asOfActivityOffset: query.asOfActivityOffset ?? 0,
        },
        status: {
          status: "unavailable",
          reason: "Activity Facts are unavailable.",
        },
      };
    }
  }
}

function compareTerminalSummaries(
  left: TerminalArchiveSummary,
  right: TerminalArchiveSummary,
): number {
  return compareTerminalTuple(left, right.lastActivityAt, right.terminalSessionId);
}

function compareTerminalTuple(
  left: TerminalArchiveSummary,
  rightAt: string,
  rightId: string,
): number {
  return rightAt.localeCompare(left.lastActivityAt) ||
    left.terminalSessionId.localeCompare(rightId);
}

function compareRunSummaries(
  left: AgentTeamArchiveSummary,
  right: AgentTeamArchiveSummary,
): number {
  return (
    runKindRank(left.runKind) - runKindRank(right.runKind) ||
    compareRunTuple(left, right.updatedAt, right.runId)
  );
}

function compareRunCursor(
  left: AgentTeamArchiveSummary,
  cursor: { at: string; id: string; group?: string },
): number {
  return cursor.group === "primary" || cursor.group === "verification_fixture"
    ? runKindRank(left.runKind) - runKindRank(cursor.group) ||
        compareRunTuple(left, cursor.at, cursor.id)
    : compareRunTuple(left, cursor.at, cursor.id);
}

function runKindRank(kind: AgentTeamArchiveSummary["runKind"]): number {
  return kind === "verification_fixture" ? 1 : 0;
}

function compareRunTuple(
  left: AgentTeamArchiveSummary,
  rightAt: string,
  rightId: string,
): number {
  return rightAt.localeCompare(left.updatedAt) || left.runId.localeCompare(rightId);
}

function compareThreadRefs(left: AppServerThreadRef, right: AppServerThreadRef) {
  return left.lastActivityAt.localeCompare(right.lastActivityAt) ||
    left.threadId.localeCompare(right.threadId);
}

function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(
  value: string | undefined,
  kind: "terminals" | "runs",
): { at: string; id: string; group?: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return parsed.kind === kind &&
      typeof parsed.at === "string" &&
      typeof parsed.id === "string"
      ? {
          at: parsed.at,
          id: parsed.id,
          ...(typeof parsed.group === "string" ? { group: parsed.group } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function decodeOffsetCursor(
  value: string | undefined,
  kind: "threads",
): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return parsed.kind === kind &&
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch {
    return 0;
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
