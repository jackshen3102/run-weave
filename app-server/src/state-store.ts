import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerAgentKind,
  AppServerAgentSessionRef,
  AppServerAgentRunStatus,
  AppServerCompletionReason,
  AppServerThreadRef,
} from "@runweave/shared";

export interface AppServerStateStoreSnapshot {
  threads: AppServerThreadRef[];
  agentSessions: AppServerAgentSessionRef[];
}

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
  private readonly agentSessions = new Map<string, AppServerAgentSessionRef>();

  constructor(
    private readonly threadStatePath: string,
    private readonly agentSessionStatePath: string,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.threadStatePath), { recursive: true });
    this.threads.clear();
    this.agentSessions.clear();
    for (const thread of await readStateArray<AppServerThreadRef>(
      this.threadStatePath,
      isThreadRef,
    )) {
      this.threads.set(thread.threadId, thread);
    }
    for (const agentSession of await readStateArray<AppServerAgentSessionRef>(
      this.agentSessionStatePath,
      isAgentSessionRef,
    )) {
      this.agentSessions.set(agentSession.agentSessionId, agentSession);
    }
  }

  clear(): void {
    this.threads.clear();
    this.agentSessions.clear();
  }

  async persist(): Promise<void> {
    await Promise.all([
      writeJsonFile(this.threadStatePath, this.listThreads({ limit: 10_000 })),
      writeJsonFile(
        this.agentSessionStatePath,
        this.listAgentSessions({ limit: 10_000 }),
      ),
    ]);
  }

  getSnapshot(): AppServerStateStoreSnapshot {
    return {
      threads: this.listThreads({ limit: 10_000 }),
      agentSessions: this.listAgentSessions({ limit: 10_000 }),
    };
  }

  getThread(threadId: string): AppServerThreadRef | null {
    return this.threads.get(threadId) ?? null;
  }

  listThreads(options: Partial<StateListOptions>): AppServerThreadRef[] {
    return filterStateRefs([...this.threads.values()], options);
  }

  listAgentSessions(
    options: Partial<StateListOptions>,
  ): AppServerAgentSessionRef[] {
    return filterStateRefs([...this.agentSessions.values()], options);
  }

  upsertThread(update: StateRefUpdate): StateStoreChange<AppServerThreadRef> {
    this.deleteFallbackThreadIfRealThreadArrived(update);
    const previous = this.threads.get(update.threadId) ?? null;
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
    return {
      previous,
      current,
      changed: !previous || !stateRefsEqual(previous, current),
    };
  }

  upsertAgentSession(
    update: StateRefUpdate,
  ): StateStoreChange<AppServerAgentSessionRef> {
    this.deleteFallbackAgentSessionIfRealThreadArrived(update);
    const agentSessionId = buildAgentSessionId(update);
    const previous = this.agentSessions.get(agentSessionId) ?? null;
    const current: AppServerAgentSessionRef = {
      agentSessionId,
      agent: update.agent,
      status: update.status,
      threadId: isFallbackThreadId(update.threadId) ? null : update.threadId,
      projectId: update.projectId,
      terminalSessionId: update.terminalSessionId,
      terminalPanelId: update.terminalPanelId,
      runId: update.runId,
      cwd: update.cwd,
      sourceInstanceId: update.sourceInstanceId,
      lastEventId: update.lastEventId,
      lastHookEvent: update.lastHookEvent,
      lastCompletionReason: update.lastCompletionReason,
      lastActivityAt: update.lastActivityAt,
      updatedAt: update.updatedAt,
    };
    this.agentSessions.set(current.agentSessionId, current);
    return {
      previous,
      current,
      changed: !previous || !stateRefsEqual(previous, current),
    };
  }

  private deleteFallbackThreadIfRealThreadArrived(update: StateRefUpdate): void {
    if (isFallbackThreadId(update.threadId)) {
      return;
    }
    this.threads.delete(buildFallbackThreadId(update));
  }

  private deleteFallbackAgentSessionIfRealThreadArrived(
    update: StateRefUpdate,
  ): void {
    if (isFallbackThreadId(update.threadId)) {
      return;
    }
    this.agentSessions.delete(buildFallbackAgentSessionId(update));
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

function buildAgentSessionId(update: StateRefUpdate): string {
  return isFallbackThreadId(update.threadId)
    ? buildFallbackAgentSessionId(update)
    : `${update.agent}:${update.threadId}`;
}

function buildFallbackAgentSessionId(identity: StateRefIdentity): string {
  return [
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
    .filter((item) => !options.projectId || item.projectId === options.projectId)
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

function isThreadRef(value: unknown): value is AppServerThreadRef {
  if (!isStateRef(value)) {
    return false;
  }
  return typeof value.threadId === "string";
}

function isAgentSessionRef(value: unknown): value is AppServerAgentSessionRef {
  if (!isStateRef(value)) {
    return false;
  }
  return typeof value.agentSessionId === "string";
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
