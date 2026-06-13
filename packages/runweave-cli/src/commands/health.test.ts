import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileStore } from "../config/profile-store.js";
import { runCli } from "../index.js";

function createIo(env: NodeJS.ProcessEnv) {
  return {
    stdout: {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    },
    stderr: {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    },
    stdin: process.stdin,
    env,
  };
}

describe("health command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the default base URL without requiring login", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrls.push(String(input));
        return Response.json({ status: "ok" });
      }),
    );
    const io = createIo({
      RUNWEAVE_CONFIG_FILE: path.join(
        await mkdtemp(path.join(os.tmpdir(), "runweave-cli-")),
        "missing.json",
      ),
    });

    const exitCode = await runCli(["health", "--json"], io);

    expect(exitCode).toBe(0);
    expect(requestedUrls).toEqual(["http://127.0.0.1:5001/health"]);
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      reachable: true,
      authenticated: false,
      baseUrl: "http://127.0.0.1:5001",
      profile: "local",
      blockedByTunnelAuth: false,
      health: { status: "ok" },
    });
    expect(io.stderr.value).toBe("");
  });

  it("uses a configured profile base URL even when it has no token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-"));
    const configFile = path.join(dir, "config.json");
    await new ProfileStore(configFile).save({
      activeProfile: "local",
      profiles: {
        local: {
          baseUrl: "http://backend.example.test/",
        },
      },
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requestedUrls.push(String(input));
        return Response.json({ status: "ok" });
      }),
    );
    const io = createIo({ RUNWEAVE_CONFIG_FILE: configFile });

    const exitCode = await runCli(["health", "--json"], io);

    expect(exitCode).toBe(0);
    expect(requestedUrls).toEqual(["http://backend.example.test/health"]);
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      reachable: true,
      authenticated: false,
      baseUrl: "http://backend.example.test",
    });
  });

  it("keeps backend reachable when auth verification returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return Response.json({ status: "ok" });
        }
        if (url.endsWith("/api/auth/verify")) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const io = createIo({
      RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
      RUNWEAVE_ACCESS_TOKEN: "expired-token",
    });

    const exitCode = await runCli(["health", "--json"], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      reachable: true,
      authenticated: false,
      blockedByTunnelAuth: false,
    });
  });

  it("reports tunnel auth blocking health separately from user auth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "Tunnel auth required" }, { status: 403 }),
      ),
    );
    const io = createIo({ RUNWEAVE_BASE_URL: "http://127.0.0.1:5001" });

    const exitCode = await runCli(["health", "--json"], io);

    expect(exitCode).toBe(3);
    expect(JSON.parse(io.stdout.value)).toMatchObject({
      reachable: false,
      authenticated: false,
      blockedByTunnelAuth: true,
      message: "Runweave health check is blocked by tunnel auth",
    });
    expect(io.stderr.value).toContain("blocked by tunnel auth");
  });
});
