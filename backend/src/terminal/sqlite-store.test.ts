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
    linkedBrowserSessionId: "session-1",
    status: "running",
    createdAt: "2026-03-29T00:00:00.000Z",
    lastActivityAt: "2026-03-29T00:00:00.000Z",
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

  it("updates activity, exit state, and deletes terminal sessions", async () => {
    const store = await createStore();
    await store.insertSession(createRecord());

    await store.updateSessionActivity({
      terminalSessionId: "terminal-1",
      lastActivityAt: "2026-03-29T00:10:00.000Z",
    });
    await store.updateSessionExit({
      terminalSessionId: "terminal-1",
      status: "exited",
      exitCode: 130,
      lastActivityAt: "2026-03-29T00:11:00.000Z",
    });

    await expect(store.getSession("terminal-1")).resolves.toEqual(
      createRecord({
        status: "exited",
        exitCode: 130,
        lastActivityAt: "2026-03-29T00:11:00.000Z",
      }),
    );

    await store.deleteSession("terminal-1");

    await expect(store.getSession("terminal-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });
});
