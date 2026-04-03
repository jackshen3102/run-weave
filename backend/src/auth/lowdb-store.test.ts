import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LowDbAuthStore } from "./lowdb-store";

describe("LowDbAuthStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("initializes the auth store with the provided default record", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-store-"));
    tempDirs.push(tempDir);
    const store = new LowDbAuthStore(path.join(tempDir, "auth-store.json"));

    const record = await store.initialize({
      username: "admin",
      password: "admin",
      jwtSecret: "jwt-secret",
      updatedAt: "2026-04-03T00:00:00.000Z",
    });

    expect(record).toEqual({
      username: "admin",
      password: "admin",
      jwtSecret: "jwt-secret",
      updatedAt: "2026-04-03T00:00:00.000Z",
    });
  });

  it("updates password and jwt secret", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-store-"));
    tempDirs.push(tempDir);
    const store = new LowDbAuthStore(path.join(tempDir, "auth-store.json"));
    await store.initialize({
      username: "admin",
      password: "admin",
      jwtSecret: "jwt-secret",
      updatedAt: "2026-04-03T00:00:00.000Z",
    });

    const record = await store.updatePassword({
      password: "new-password",
      jwtSecret: "next-secret",
      updatedAt: "2026-04-03T01:00:00.000Z",
    });

    expect(record).toEqual({
      username: "admin",
      password: "new-password",
      jwtSecret: "next-secret",
      updatedAt: "2026-04-03T01:00:00.000Z",
    });
  });
});
