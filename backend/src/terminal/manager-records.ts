import type { TerminalState } from "@runweave/shared";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
  TerminalRuntimeKind,
} from "./store";
import {
  createScrollbackBuffer,
  readScrollbackBuffer,
  type ScrollbackBuffer,
} from "./scrollback-buffer";

export interface TerminalProjectRecord {
  id: string;
  name: string;
  path: string | null;
  createdAt: Date;
  isDefault: boolean;
  order?: number;
}

export interface TerminalSessionRecord {
  id: string;
  projectId: string;
  alias: string | null;
  threadId?: string;
  preview?: string;
  command: string;
  args: string[];
  cwd: string;
  activeCommand: string | null;
  scrollback: string;
  status: "running" | "exited";
  createdAt: Date;
  lastActivityAt: Date;
  exitCode?: number;
  order?: number;
  runtimeKind: TerminalRuntimeKind;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
  tmuxUnavailableReason?: string;
  recoverable?: boolean;
  terminalState?: TerminalState;
}

export interface RuntimeTerminalSessionRecord extends Omit<
  TerminalSessionRecord,
  "scrollback"
> {
  readonly scrollback: string;
  scrollbackBuffer: ScrollbackBuffer;
  scrollbackLoaded: boolean;
}

export interface CreateTerminalSessionOptions {
  projectId?: string;
  command: string;
  args?: string[];
  cwd: string;
}

export function buildProjectRecord(
  persisted: PersistedTerminalProjectRecord,
): TerminalProjectRecord {
  return {
    id: persisted.id,
    name: persisted.name,
    path: persisted.path ?? null,
    createdAt: new Date(persisted.createdAt),
    isDefault: persisted.isDefault,
    ...(persisted.order !== undefined ? { order: persisted.order } : {}),
  };
}

export function toPersistedProject(
  project: TerminalProjectRecord,
): PersistedTerminalProjectRecord {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    createdAt: project.createdAt.toISOString(),
    isDefault: project.isDefault,
  };
}

export function buildSessionRecord(
  persisted: PersistedTerminalSessionMetadataRecord & { scrollback?: string },
): TerminalSessionRecord {
  return {
    id: persisted.id,
    projectId: persisted.projectId,
    alias: persisted.alias ?? null,
    threadId: persisted.threadId,
    preview: persisted.preview,
    command: persisted.command,
    args: persisted.args,
    cwd: persisted.cwd,
    activeCommand: persisted.activeCommand ?? null,
    scrollback: persisted.scrollback ?? "",
    status: persisted.status,
    createdAt: new Date(persisted.createdAt),
    lastActivityAt: new Date(persisted.lastActivityAt ?? persisted.createdAt),
    exitCode: persisted.exitCode,
    ...(persisted.order !== undefined ? { order: persisted.order } : {}),
    runtimeKind: persisted.runtimeKind ?? "pty",
    tmuxSessionName: persisted.tmuxSessionName,
    tmuxSocketPath: persisted.tmuxSocketPath,
    tmuxUnavailableReason: persisted.tmuxUnavailableReason,
    recoverable: persisted.recoverable,
    ...(persisted.terminalState !== undefined
      ? { terminalState: persisted.terminalState }
      : {}),
  };
}

export function createRuntimeRecord(
  record: TerminalSessionRecord,
  options?: { scrollbackLoaded?: boolean },
): RuntimeTerminalSessionRecord {
  const { scrollback, ...rest } = record;
  const runtimeRecord = { ...rest } as Omit<
    RuntimeTerminalSessionRecord,
    "scrollback" | "scrollbackBuffer"
  > &
    Partial<Pick<RuntimeTerminalSessionRecord, "scrollbackBuffer">>;

  Object.defineProperty(runtimeRecord, "scrollbackBuffer", {
    configurable: false,
    enumerable: false,
    value: createScrollbackBuffer(scrollback),
    writable: true,
  });
  Object.defineProperty(runtimeRecord, "scrollbackLoaded", {
    configurable: false,
    enumerable: false,
    value: options?.scrollbackLoaded ?? true,
    writable: true,
  });

  Object.defineProperty(runtimeRecord, "scrollback", {
    configurable: false,
    enumerable: true,
    get() {
      return readScrollbackBuffer(runtimeRecord.scrollbackBuffer!);
    },
  });

  return runtimeRecord as RuntimeTerminalSessionRecord;
}

export function toPersistedSession(
  session: TerminalSessionRecord,
): PersistedTerminalSessionRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    alias: session.alias,
    threadId: session.threadId,
    preview: session.preview,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    activeCommand: session.activeCommand,
    scrollback: session.scrollback,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    exitCode: session.exitCode,
    runtimeKind: session.runtimeKind,
    tmuxSessionName: session.tmuxSessionName,
    tmuxSocketPath: session.tmuxSocketPath,
    tmuxUnavailableReason: session.tmuxUnavailableReason,
    recoverable: session.recoverable,
    ...(session.terminalState !== undefined
      ? { terminalState: session.terminalState }
      : {}),
  };
}
