import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  TERMINAL_COMPACTED_SCROLLBACK_BYTES,
  TERMINAL_PERSISTED_SCROLLBACK_BYTES,
} from "@browser-viewer/shared";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PersistedTerminalProjectRecord,
  PersistedTerminalSessionRecord,
} from "./store";
import { LowDbTerminalSessionStore } from "./lowdb-store";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-store-"));
  tempDirs.push(dir);
  const store = new LowDbTerminalSessionStore(
    path.join(dir, "terminal-session-store.json"),
  );
  await store.initialize();
  return store;
}

function createRecord(
  overrides?: Partial<PersistedTerminalSessionRecord>,
): PersistedTerminalSessionRecord {
  return {
    id: "terminal-1",
    projectId: "project-1",
    command: "bash",
    args: ["-l"],
    cwd: "/tmp/demo",
    activeCommand: null,
    scrollback: "",
    status: "running",
    createdAt: "2026-03-29T00:00:00.000Z",
    ...overrides,
  };
}

function resolveScrollbackFile(dir: string, terminalSessionId: string): string {
  return path.join(dir, "terminal-scrollback", `${terminalSessionId}.log`);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("LowDbTerminalSessionStore", () => {
  it("bootstraps a default terminal project on first initialize", async () => {
    const store = await createStore();

    await expect(
      (
        store as unknown as {
          listProjects: () => Promise<PersistedTerminalProjectRecord[]>;
        }
      ).listProjects(),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "Default Project",
        isDefault: true,
      }),
    ]);
  });

  it("persists terminal metadata in JSON and scrollback in a per-session file", async () => {
    const store = await createStore();
    const record = createRecord({ scrollback: "boot transcript\n" });

    await store.insertSession(record);

    await expect(store.getSession(record.id)).resolves.toEqual(record);
    await expect(store.listSessions()).resolves.toEqual([record]);

    const persisted = JSON.parse(
      await readFile(
        path.join(tempDirs[0] ?? "", "terminal-session-store.json"),
        "utf8",
      ),
    ) as {
      projects?: PersistedTerminalProjectRecord[];
      sessions: Array<
        Omit<PersistedTerminalSessionRecord, "scrollback"> & {
          scrollback?: string;
        }
      >;
    };
    expect(persisted.sessions).toEqual([
      expect.not.objectContaining({ scrollback: expect.any(String) }),
    ]);
    expect(persisted.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isDefault: true,
        }),
      ]),
    );
    await expect(
      readFile(resolveScrollbackFile(tempDirs[0] ?? "", record.id), "utf8"),
    ).resolves.toBe("boot transcript\n");
  });

  it("lists session metadata without reading scrollback files", async () => {
    const store = await createStore();
    const record = createRecord({ scrollback: "boot transcript\n" });

    await store.insertSession(record);
    await rm(resolveScrollbackFile(tempDirs[0] ?? "", record.id), {
      force: true,
    });

    await expect(store.listSessionMetadata()).resolves.toEqual([
      {
        id: record.id,
        projectId: record.projectId,
        command: record.command,
        args: record.args,
        cwd: record.cwd,
        activeCommand: null,
        status: record.status,
        createdAt: record.createdAt,
        exitCode: record.exitCode,
      },
    ]);
  });

  it("migrates legacy terminal sessions into the default project and external scrollback file on initialize", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-store-"));
    tempDirs.push(dir);
    const storeFile = path.join(dir, "terminal-session-store.json");
    await writeFile(
      storeFile,
      JSON.stringify({
        sessions: [
          {
            id: "legacy-terminal-1",
            name: "legacy-shell",
            command: "bash",
            args: [],
            cwd: "/tmp/legacy",
            scrollback: "legacy transcript\n",
            status: "running",
            createdAt: "2026-03-29T00:00:00.000Z",
          },
          {
            id: "legacy-terminal-2",
            name: "legacy-project_codex",
            command: "bash",
            args: [],
            cwd: "/tmp/legacy-project",
            status: "running",
            createdAt: "2026-03-29T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = new LowDbTerminalSessionStore(storeFile);
    await store.initialize();

    const [defaultProject] = await (
      store as unknown as {
        listProjects: () => Promise<PersistedTerminalProjectRecord[]>;
      }
    ).listProjects();
    const [migratedSession, migratedCommandSession] = await store.listSessions();

    expect(defaultProject).toEqual(
      expect.objectContaining({
        isDefault: true,
      }),
    );
    expect(migratedSession).toEqual(
      expect.objectContaining({
        id: "legacy-terminal-1",
        projectId: defaultProject?.id,
        activeCommand: null,
        scrollback: "legacy transcript\n",
      }),
    );
    expect(migratedCommandSession).toEqual(
      expect.objectContaining({
        id: "legacy-terminal-2",
        projectId: defaultProject?.id,
        activeCommand: "codex",
      }),
    );
    const migratedPersisted = JSON.parse(await readFile(storeFile, "utf8")) as {
      sessions: Array<{ name?: string; scrollback?: string }>;
    };
    expect(migratedPersisted.sessions[0]).not.toHaveProperty("scrollback");
    expect(migratedPersisted.sessions[0]).not.toHaveProperty("name");
    expect(migratedPersisted.sessions[1]).not.toHaveProperty("name");
    await expect(
      readFile(resolveScrollbackFile(dir, "legacy-terminal-1"), "utf8"),
    ).resolves.toBe("legacy transcript\n");
  });

  it("updates terminal metadata, scrollback, exit state, and deletion", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionMetadata({
      terminalSessionId: "terminal-1",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
      activeCommand: "codex",
    });
    await store.updateSessionScrollback({
      terminalSessionId: "terminal-1",
      scrollback: "hello world",
    });
    await store.updateSessionExit({
      terminalSessionId: "terminal-1",
      status: "exited",
      exitCode: 130,
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        activeCommand: "codex",
        status: "exited",
        exitCode: 130,
        scrollback: "hello world",
      }),
    );

    await store.deleteSession("terminal-1");

    await expect(store.getSession("terminal-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(
      readFile(resolveScrollbackFile(tempDirs[0] ?? "", "terminal-1"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists terminal runtime metadata in session JSON", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionRuntimeMetadata({
      terminalSessionId: "terminal-1",
      runtimeKind: "tmux",
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
      recoverable: true,
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        runtimeKind: "tmux",
        tmuxSessionName: "runweave-terminal-1",
        tmuxSocketPath: "/tmp/runweave/tmux.sock",
        recoverable: true,
      }),
    );
    const persisted = JSON.parse(
      await readFile(
        path.join(tempDirs[0] ?? "", "terminal-session-store.json"),
        "utf8",
      ),
    ) as {
      sessions: Array<{
        runtimeKind?: string;
        tmuxSessionName?: string;
        tmuxSocketPath?: string;
        recoverable?: boolean;
      }>;
    };
    expect(persisted.sessions[0]).toMatchObject({
      runtimeKind: "tmux",
      tmuxSessionName: "runweave-terminal-1",
      tmuxSocketPath: "/tmp/runweave/tmux.sock",
      recoverable: true,
    });
  });

  it("appends scrollback chunks without rewriting terminal metadata JSON", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());
    const database = (
      store as unknown as { database: { write: () => Promise<void> } | null }
    ).database;

    if (!database) {
      throw new Error("expected initialized database");
    }

    database.write = async () => {
      throw new Error("metadata JSON write should not run");
    };

    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: "hello",
    });
    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: " world",
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({ scrollback: "hello world" }),
    );
    await expect(
      readFile(resolveScrollbackFile(tempDirs[0] ?? "", "terminal-1"), "utf8"),
    ).resolves.toBe("hello world");
  });

  it("compacts oversized scrollback files back to the hysteresis target", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());
    const initialScrollback = "a".repeat(TERMINAL_PERSISTED_SCROLLBACK_BYTES);

    await store.updateSessionScrollback({
      terminalSessionId: "terminal-1",
      scrollback: initialScrollback,
    });
    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: "tail-marker",
    });

    const compacted = await readFile(
      resolveScrollbackFile(tempDirs[0] ?? "", "terminal-1"),
      "utf8",
    );
    expect(Buffer.byteLength(compacted, "utf8")).toBe(
      TERMINAL_COMPACTED_SCROLLBACK_BYTES,
    );
    expect(compacted.endsWith("tail-marker")).toBe(true);
  });

  it("does not wait for pending metadata JSON writes before appending scrollback", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());
    const database = (
      store as unknown as { database: { write: () => Promise<void> } | null }
    ).database;
    let finishMetadataWrite: () => void = () => undefined;

    if (!database) {
      throw new Error("expected initialized database");
    }

    database.write = async () =>
      await new Promise<void>((resolve) => {
        finishMetadataWrite = resolve;
      });

    const pendingMetadataWrite = store.updateSessionMetadata({
      terminalSessionId: "terminal-1",
      cwd: "/tmp/browser-hub",
      activeCommand: null,
    });
    const appendResult = store
      .appendSessionScrollback({
        terminalSessionId: "terminal-1",
        chunk: "hello",
      })
      .then(() => "appended");

    await expect(
      Promise.race([
        appendResult,
        new Promise<"blocked">((resolve) => {
          setTimeout(() => {
            resolve("blocked");
          }, 1_000);
        }),
      ]),
    ).resolves.toBe("appended");

    finishMetadataWrite();
    await pendingMetadataWrite;
    await expect(
      readFile(resolveScrollbackFile(tempDirs[0] ?? "", "terminal-1"), "utf8"),
    ).resolves.toBe("hello");
  });

  it("updates terminal launch config in place", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionLaunch({
      terminalSessionId: "terminal-1",
      command: "/bin/zsh",
      args: ["-l"],
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        command: "/bin/zsh",
        args: ["-l"],
      }),
    );
  });

  it("propagates write failures to callers", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());
    const writeError = new Error("write failed");
    const database = (
      store as unknown as { database: { write: () => Promise<void> } | null }
    ).database;

    if (!database) {
      throw new Error("expected initialized database");
    }

    database.write = async () => {
      throw writeError;
    };

    await expect(
      store.updateSessionMetadata({
        terminalSessionId: "terminal-1",
        cwd: "/tmp/browser-hub",
        activeCommand: null,
      }),
    ).rejects.toThrow(writeError);
  });

  it("surfaces the last queued write failure during dispose", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());
    const writeError = new Error("write failed");
    const database = (
      store as unknown as { database: { write: () => Promise<void> } | null }
    ).database;

    if (!database) {
      throw new Error("expected initialized database");
    }

    database.write = async () => {
      throw writeError;
    };

    await expect(
      store.updateSessionMetadata({
        terminalSessionId: "terminal-1",
        cwd: "/tmp/browser-hub",
        activeCommand: null,
      }),
    ).rejects.toThrow(writeError);
    await expect(store.dispose()).rejects.toThrow(writeError);
  });
});
