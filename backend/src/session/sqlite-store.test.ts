import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedSessionRecord } from "./store";
import { SQLiteSessionStore } from "./sqlite-store";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-store-"));
  tempDirs.push(dir);
  const store = new SQLiteSessionStore(path.join(dir, "session-store.db"));
  await store.initialize();
  return store;
}

function createRecord(
  overrides?: Partial<PersistedSessionRecord>,
): PersistedSessionRecord {
  return {
    id: "session-1",
    targetUrl: "https://example.com",
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

describe("SQLiteSessionStore", () => {
  it("persists and reads sessions", async () => {
    const store = await createStore();
    const record = createRecord();

    await store.insertSession(record);

    await expect(store.getSession(record.id)).resolves.toEqual(record);
    await expect(store.listSessions()).resolves.toEqual([record]);
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

  it("keeps proxyEnabled false when stored as disabled", async () => {
    const store = await createStore();

    await store.insertSession(
      createRecord({ id: "session-2", proxyEnabled: false }),
    );

    await expect(store.getSession("session-2")).resolves.toEqual(
      createRecord({ id: "session-2", proxyEnabled: false }),
    );
  });

  it("persists custom profile mode", async () => {
    const store = await createStore();

    await store.insertSession(
      createRecord({
        id: "session-3",
        profileMode: "custom",
        profilePath: "/profiles/custom-profile",
      }),
    );

    await expect(store.getSession("session-3")).resolves.toEqual(
      createRecord({
        id: "session-3",
        profileMode: "custom",
        profilePath: "/profiles/custom-profile",
      }),
    );
  });

  it("persists session headers", async () => {
    const store = await createStore();

    await store.insertSession(
      createRecord({
        id: "session-4",
        headers: {
          authorization: "Bearer demo",
          "x-session-id": "session-4",
        },
      }),
    );

    await expect(store.getSession("session-4")).resolves.toEqual(
      createRecord({
        id: "session-4",
        headers: {
          authorization: "Bearer demo",
          "x-session-id": "session-4",
        },
      }),
    );
  });
});
