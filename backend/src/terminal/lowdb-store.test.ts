import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    name: "shell",
    command: "bash",
    args: ["-l"],
    cwd: "/tmp/demo",
    scrollback: "",
    status: "running",
    createdAt: "2026-03-29T00:00:00.000Z",
    ...overrides,
  };
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
      (store as unknown as { listProjects: () => Promise<PersistedTerminalProjectRecord[]> })
        .listProjects(),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "Default Project",
        isDefault: true,
      }),
    ]);
  });

  it("persists and reads terminal sessions from a JSON file", async () => {
    const store = await createStore();
    const record = createRecord();

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
      sessions: PersistedTerminalSessionRecord[];
    };
    expect(persisted.sessions).toEqual([record]);
    expect(persisted.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isDefault: true,
        }),
      ]),
    );
  });

  it("migrates legacy terminal sessions into the default project on initialize", async () => {
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
            scrollback: "",
            status: "running",
            createdAt: "2026-03-29T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = new LowDbTerminalSessionStore(storeFile);
    await store.initialize();

    const [defaultProject] = await (
      store as unknown as { listProjects: () => Promise<PersistedTerminalProjectRecord[]> }
    ).listProjects();
    const [migratedSession] = await store.listSessions();

    expect(defaultProject).toEqual(
      expect.objectContaining({
        isDefault: true,
      }),
    );
    expect(migratedSession).toEqual(
      expect.objectContaining({
        id: "legacy-terminal-1",
        projectId: defaultProject?.id,
      }),
    );
  });

  it("updates terminal metadata, scrollback, exit state, and deletion", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionMetadata({
      terminalSessionId: "terminal-1",
      name: "browser-hub",
      cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
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
        name: "browser-hub",
        cwd: "/Users/bytedance/Desktop/vscode/browser-hub/feat",
        status: "exited",
        exitCode: 130,
        scrollback: "hello world",
      }),
    );

    await store.deleteSession("terminal-1");

    await expect(store.getSession("terminal-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("updates terminal launch config in place", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionLaunch({
      terminalSessionId: "terminal-1",
      name: "/bin/zsh",
      command: "/bin/zsh",
      args: ["-l"],
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        name: "/bin/zsh",
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
      store.updateSessionScrollback({
        terminalSessionId: "terminal-1",
        scrollback: "hello world",
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
      store.updateSessionScrollback({
        terminalSessionId: "terminal-1",
        scrollback: "hello world",
      }),
    ).rejects.toThrow(writeError);
    await expect(store.dispose()).rejects.toThrow(writeError);
  });
});
