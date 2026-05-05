import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "./profile-store.js";

describe("ProfileStore", () => {
  it("writes config files with owner-only permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-"));
    const store = new ProfileStore(path.join(dir, "config.json"));

    await store.saveProfile("local", {
      baseUrl: "http://127.0.0.1:5001",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const stats = await stat(store.filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
