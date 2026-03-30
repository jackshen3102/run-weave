import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedTerminalSessionRecord } from "./store";
import { SQLiteTerminalSessionStore } from "./sqlite-store";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-store-"));
  tempDirs.push(dir);
  const store = new SQLiteTerminalSessionStore(path.join(dir, "terminal.db"));
  await store.initialize();
  return store;
}

function createRecord(
  overrides?: Partial<PersistedTerminalSessionRecord>,
): PersistedTerminalSessionRecord {
  return {
    id: "terminal-1",
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

describe("SQLiteTerminalSessionStore", () => {
  it("persists and reads terminal sessions", async () => {
    const store = await createStore();
    const record = createRecord();

    await store.insertSession(record);

    await expect(store.getSession(record.id)).resolves.toEqual(record);
    await expect(store.listSessions()).resolves.toEqual([record]);
  });

  it("updates exit state and deletes terminal sessions", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: "hello",
      maxLength: 16,
    });
    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: " world",
      maxLength: 16,
    });
    await store.updateSessionExit({
      terminalSessionId: "terminal-1",
      status: "exited",
      exitCode: 130,
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        status: "exited",
        exitCode: 130,
        scrollback: "hello world",
      }),
    );

    await store.deleteSession("terminal-1");

    await expect(store.getSession("terminal-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("trims persisted scrollback to max length", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.appendSessionScrollback({
      terminalSessionId: "terminal-1",
      chunk: "12345",
      maxLength: 4,
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        scrollback: "2345",
      }),
    );
  });

  it("removes the legacy linked browser session column during initialization", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "terminal-store-legacy-"));
    tempDirs.push(dir);
    const databaseFile = path.join(dir, "terminal.db");

    const DatabaseModule = await import("better-sqlite3");
    const database = new DatabaseModule.default(databaseFile);
    database.exec(`
      create table terminal_sessions (
        id text primary key,
        name text not null,
        command text not null,
        args_json text not null default '[]',
        cwd text not null,
        linked_browser_session_id text,
        scrollback text not null default '',
        status text not null,
        created_at text not null,
        last_activity_at text not null,
        exit_code integer
      );
    `);
    database.close();

    const store = new SQLiteTerminalSessionStore(databaseFile);
    await store.initialize();

    const verificationDb = new DatabaseModule.default(databaseFile, {
      readonly: true,
    });
    const columns = verificationDb
      .prepare("pragma table_info(terminal_sessions)")
      .all() as Array<{ name: string }>;
    verificationDb.close();

    expect(columns.map((column) => column.name)).not.toContain(
      "linked_browser_session_id",
    );
    expect(columns.map((column) => column.name)).not.toContain(
      "last_activity_at",
    );
  });
});
