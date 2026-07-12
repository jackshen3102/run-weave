import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerAgentKind,
  AppServerAgentRunStatus,
  AppServerCompletionReason,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";

export interface AppServerStateStoreSnapshot {
  threads: AppServerThreadRef[];
}

type PersistedAppServerThreadRef = AppServerThreadRef & {
  terminalTmuxPaneId?: string | null;
};

export interface StateRefIdentity {
  agent: AppServerAgentKind;
  threadId: string;
  terminalSessionId: string | null;
  terminalPanelId: string | null;
  sourceInstanceId: string | null;
}

export interface StateRefUpdate {
  agent: AppServerAgentKind;
  status: AppServerAgentRunStatus;
  threadId: string;
  projectId: string | null;
  terminalSessionId: string | null;
  terminalPanelId: string | null;
  terminalTmuxPaneId: string | null;
  runId: string | null;
  cwd: string | null;
  sourceInstanceId: string | null;
  lastEventId: string;
  lastHookEvent: string | null;
  lastCompletionReason: AppServerCompletionReason | null;
  lastActivityAt: string;
  updatedAt: string;
}

export interface StateStoreChange<T> {
  previous: T | null;
  current: T;
  changed: boolean;
}

export interface StateListOptions {
  projectId?: string | null;
  terminalSessionId?: string | null;
  terminalPanelId?: string | null;
  agent?: AppServerAgentKind | null;
  status?: AppServerAgentRunStatus | null;
  after?: string | null;
  limit: number;
}

export class AppServerStateStore {
  private readonly threads = new Map<string, AppServerThreadRef>();
  private readonly threadTmuxPaneIds = new Map<string, string | null>();

  constructor(private readonly threadStatePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.threadStatePath), { recursive: true });
    this.threads.clear();
    this.threadTmuxPaneIds.clear();
    for (const persistedThread of await readStateArray<PersistedAppServerThreadRef>(
      this.threadStatePath,
      isThreadRef,
    )) {
      const { terminalTmuxPaneId = null, ...thread } = persistedThread;
      this.threads.set(thread.threadId, thread);
      this.threadTmuxPaneIds.set(thread.threadId, terminalTmuxPaneId);
    }
  }

  clear(): void {
    this.threads.clear();
    this.threadTmuxPaneIds.clear();
  }

  async persist(): Promise<void> {
    await writeJsonFile(
      this.threadStatePath,
      this.listThreads({ limit: 10_000 }).map((thread) => ({
        ...thread,
        terminalTmuxPaneId: this.threadTmuxPaneIds.get(thread.threadId) ?? null,
      })),
    );
  }

  getSnapshot(): AppServerStateStoreSnapshot {
    return {
      threads: this.listThreads({ limit: 10_000 }),
    };
  }

  getThread(threadId: string): AppServerThreadRef | null {
    return this.threads.get(threadId) ?? null;
  }

  getThreadTmuxPaneId(threadId: string): string | null {
    return this.threadTmuxPaneIds.get(threadId) ?? null;
  }

  listThreads(options: Partial<StateListOptions>): AppServerThreadRef[] {
    return filterStateRefs([...this.threads.values()], options);
  }

  upsertThread(update: StateRefUpdate): StateStoreChange<AppServerThreadRef> {
    this.deleteFallbackThreadIfRealThreadArrived(update);
    const previous = this.threads.get(update.threadId) ?? null;
    const previousTmuxPaneId =
      this.threadTmuxPaneIds.get(update.threadId) ?? null;
    const current: AppServerThreadRef = {
      threadId: update.threadId,
      agent: update.agent,
      status: update.status,
      projectId: update.projectId,
      terminalSessionId: update.terminalSessionId,
      terminalPanelId: update.terminalPanelId,
      runId: update.runId,
      cwd: update.cwd,
      detailRef: isFallbackThreadId(update.threadId)
        ? null
        : { provider: update.agent, id: update.threadId },
      sourceInstanceId: update.sourceInstanceId,
      lastEventId: update.lastEventId,
      lastHookEvent: update.lastHookEvent,
      lastCompletionReason: update.lastCompletionReason,
      lastActivityAt: update.lastActivityAt,
      updatedAt: update.updatedAt,
    };
    this.threads.set(current.threadId, current);
    this.threadTmuxPaneIds.set(current.threadId, update.terminalTmuxPaneId);
    return {
      previous,
      current,
      changed:
        !previous ||
        !stateRefsEqual(previous, current) ||
        previousTmuxPaneId !== update.terminalTmuxPaneId,
    };
  }

  private deleteFallbackThreadIfRealThreadArrived(
    update: StateRefUpdate,
  ): void {
    if (isFallbackThreadId(update.threadId)) {
      return;
    }
    const fallbackThreadId = buildFallbackThreadId(update);
    this.threads.delete(fallbackThreadId);
    this.threadTmuxPaneIds.delete(fallbackThreadId);
  }
}

export function buildFallbackThreadId(identity: StateRefIdentity): string {
  return [
    "unknown-thread",
    identity.agent,
    identity.terminalSessionId ?? "none",
    identity.terminalPanelId ?? "none",
    identity.sourceInstanceId ?? "none",
  ].join(":");
}

function isFallbackThreadId(threadId: string): boolean {
  return threadId.startsWith("unknown-thread:");
}

function filterStateRefs<
  T extends {
    projectId: string | null;
    terminalSessionId: string | null;
    terminalPanelId: string | null;
    agent: AppServerAgentKind;
    status: AppServerAgentRunStatus;
    lastEventId: string;
  },
>(items: T[], options: Partial<StateListOptions>): T[] {
  const after = options.after ? Number(options.after) : 0;
  return items
    .filter(
      (item) => !options.projectId || item.projectId === options.projectId,
    )
    .filter(
      (item) =>
        !options.terminalSessionId ||
        item.terminalSessionId === options.terminalSessionId,
    )
    .filter(
      (item) =>
        !options.terminalPanelId ||
        item.terminalPanelId === options.terminalPanelId,
    )
    .filter((item) => !options.agent || item.agent === options.agent)
    .filter((item) => !options.status || item.status === options.status)
    .filter((item) => Number(item.lastEventId) > after)
    .sort((left, right) => Number(left.lastEventId) - Number(right.lastEventId))
    .slice(0, options.limit ?? 100);
}

async function readStateArray<T>(
  filePath: string,
  predicate: (value: unknown) => value is T,
): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(predicate) : [];
  } catch {
    return [];
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isThreadRef(value: unknown): value is PersistedAppServerThreadRef {
  if (!isStateRef(value)) {
    return false;
  }
  return (
    typeof value.threadId === "string" &&
    (value.terminalTmuxPaneId === undefined ||
      value.terminalTmuxPaneId === null ||
      typeof value.terminalTmuxPaneId === "string")
  );
}

function isStateRef(value: unknown): value is Record<string, unknown> & {
  agent: AppServerAgentKind;
  status: AppServerAgentRunStatus;
  lastEventId: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isAgentKind(record.agent) &&
    isRunStatus(record.status) &&
    typeof record.lastEventId === "string"
  );
}

function isAgentKind(value: unknown): value is AppServerAgentKind {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "trae" ||
    value === "traecli" ||
    value === "traex" ||
    value === "unknown"
  );
}

function isRunStatus(value: unknown): value is AppServerAgentRunStatus {
  return (
    value === "starting" ||
    value === "running" ||
    value === "idle" ||
    value === "completed" ||
    value === "failed" ||
    value === "unknown"
  );
}

function stateRefsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
