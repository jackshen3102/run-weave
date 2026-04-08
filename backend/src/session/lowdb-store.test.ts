import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedSessionRecord } from "./store";
import { LowDbSessionStore } from "./lowdb-store";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-store-"));
  tempDirs.push(dir);
  const store = new LowDbSessionStore(path.join(dir, "session-store.json"));
  await store.initialize();
  return store;
}

function createRecord(
  overrides?: Partial<PersistedSessionRecord>,
): PersistedSessionRecord {
  return {
    id: "session-1",
    name: "Default Playweight",
    preferredForAi: false,
    proxyEnabled: true,
    connected: false,
    profilePath: "/profiles/session-1",
    profileMode: "managed",
    headers: {},
    createdAt: "2026-03-21T00:00:00.000Z",
    lastActivityAt: "2026-03-21T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("LowDbSessionStore", () => {
  it("persists and reads sessions from a JSON file", async () => {
    const store = await createStore();
    const record = createRecord();

    await store.insertSession(record);

    await expect(store.getSession(record.id)).resolves.toEqual(record);
    await expect(store.listSessions()).resolves.toEqual([record]);

    const persisted = JSON.parse(
      await readFile(
        path.join(tempDirs[0] ?? "", "session-store.json"),
        "utf8",
      ),
    ) as { sessions: PersistedSessionRecord[] };
    expect(persisted.sessions).toEqual([record]);
  });

  it("updates connection state and deletes sessions", async () => {
    const store = await createStore();

    await store.insertSession(createRecord());
    await store.updateSessionConnection({
      sessionId: "session-1",
      connected: true,
      lastActivityAt: "2026-03-21T01:00:00.000Z",
    });

    await expect(store.getSession("session-1")).resolves.toEqual(
      createRecord({
        connected: true,
        lastActivityAt: "2026-03-21T01:00:00.000Z",
      }),
    );

    await store.deleteSession("session-1");

    await expect(store.getSession("session-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("keeps at most one preferred ai session in storage", async () => {
    const store = await createStore();

    await store.insertSession(createRecord());
    await store.insertSession(
      createRecord({
        id: "session-2",
        name: "Second session",
        profilePath: "/profiles/session-2",
      }),
    );

    await store.setPreferredForAiSession("session-2");

    await expect(store.getSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        id: "session-1",
        preferredForAi: false,
      }),
    );
    await expect(store.getSession("session-2")).resolves.toEqual(
      expect.objectContaining({
        id: "session-2",
        preferredForAi: true,
      }),
    );

    await store.setPreferredForAiSession(null);

    await expect(store.getSession("session-1")).resolves.toEqual(
      expect.objectContaining({
        id: "session-1",
        preferredForAi: false,
      }),
    );
    await expect(store.getSession("session-2")).resolves.toEqual(
      expect.objectContaining({
        id: "session-2",
        preferredForAi: false,
      }),
    );
  });

  it("propagates write failures to callers", async () => {
    const store = await createStore();
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

    await expect(store.insertSession(createRecord())).rejects.toThrow(writeError);
  });

  it("surfaces the last queued write failure during dispose", async () => {
    const store = await createStore();
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

    await expect(store.insertSession(createRecord())).rejects.toThrow(writeError);
    await expect(store.dispose()).rejects.toThrow(writeError);
  });
});
