import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionRecord } from "./manager";
import { logOrphanedTmuxSessions } from "./tmux-orphan-scan";
import type { TmuxSessionInfo, TmuxService } from "./tmux-service";

function createSession(
  overrides: Partial<TerminalSessionRecord>,
): TerminalSessionRecord {
  return {
    id: "terminal-1",
    projectId: "project-1",
    command: "zsh",
    args: [],
    cwd: "/tmp",
    activeCommand: null,
    scrollback: "",
    status: "running",
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    lastActivityAt: new Date("2026-05-15T00:00:00.000Z"),
    runtimeKind: "pty",
    ...overrides,
  };
}

function createManager(sessions: TerminalSessionRecord[]) {
  return {
    listSessions: () => sessions,
  };
}

function createTmuxService(overrides: {
  isAvailable?: () => Promise<boolean>;
  getUnavailableReason?: () => Promise<string | null>;
  listOrphanedSessions?: (
    knownSessionNames: ReadonlySet<string>,
  ) => Promise<TmuxSessionInfo[]>;
}) {
  return {
    socketPath: "/tmp/runweave-test/tmux.sock",
    buildSessionName: (terminalSessionId: string) =>
      `runweave-${terminalSessionId}`,
    getUnavailableReason: overrides.getUnavailableReason ?? (async () => null),
    isAvailable: overrides.isAvailable ?? (async () => true),
    listOrphanedSessions: overrides.listOrphanedSessions ?? (async () => []),
  } as Pick<
    TmuxService,
    | "buildSessionName"
    | "getUnavailableReason"
    | "isAvailable"
    | "listOrphanedSessions"
    | "socketPath"
  >;
}

describe("logOrphanedTmuxSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips startup scan when tmux is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listOrphanedSessions = vi.fn(async () => []);

    await logOrphanedTmuxSessions(
      createManager([createSession({ runtimeKind: "tmux" })]),
      createTmuxService({
        isAvailable: async () => false,
        getUnavailableReason: async () => "tmux disabled",
        listOrphanedSessions,
      }),
    );

    expect(listOrphanedSessions).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[viewer-be] skipped orphaned tmux session scan",
      {
        socketPath: "/tmp/runweave-test/tmux.sock",
        reason: "tmux disabled",
      },
    );
  });

  it("does not fail startup when orphan scan command fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      logOrphanedTmuxSessions(
        createManager([]),
        createTmuxService({
          listOrphanedSessions: async () => {
            throw new Error("list-sessions failed");
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[viewer-be] failed to scan orphaned tmux sessions",
      {
        socketPath: "/tmp/runweave-test/tmux.sock",
        error: "Error: list-sessions failed",
      },
    );
  });

  it("scans with only known tmux-backed session names", async () => {
    let knownSessionNames: ReadonlySet<string> | null = null;
    const listOrphanedSessions = vi.fn(
      async (nextKnownSessionNames: ReadonlySet<string>) => {
        knownSessionNames = nextKnownSessionNames;
        return [];
      },
    );

    await logOrphanedTmuxSessions(
      createManager([
        createSession({
          id: "terminal-1",
          runtimeKind: "tmux",
          tmuxSessionName: "runweave-custom-1",
        }),
        createSession({
          id: "terminal-2",
          runtimeKind: "tmux",
        }),
        createSession({
          id: "terminal-3",
          runtimeKind: "pty",
        }),
      ]),
      createTmuxService({ listOrphanedSessions }),
    );

    expect(listOrphanedSessions).toHaveBeenCalledTimes(1);
    expect([...(knownSessionNames ?? new Set<string>())]).toEqual([
      "runweave-custom-1",
      "runweave-terminal-2",
    ]);
  });
});
