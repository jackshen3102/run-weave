import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../index.js";

function createIo() {
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
    env: {
      RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
      RUNWEAVE_ACCESS_TOKEN: "access-token",
    },
  };
}

describe("app command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints the app home overview payload as JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/app/home/overview")) {
          return Response.json({
            projects: [
              {
                projectId: "project-1",
                name: "Demo",
                path: "/tmp/demo",
                createdAt: "2026-06-13T00:00:00.000Z",
                isDefault: true,
              },
            ],
            sessions: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const io = createIo();

    const exitCode = await runCli(["app", "overview", "--json"], io);

    expect(exitCode).toBe(0);
    expect(io.stderr.value).toBe("");
    expect(JSON.parse(io.stdout.value)).toEqual({
      projects: [
        {
          projectId: "project-1",
          name: "Demo",
          path: "/tmp/demo",
          createdAt: "2026-06-13T00:00:00.000Z",
          isDefault: true,
        },
      ],
      sessions: [],
    });
  });

  it("requests the backend for overview even when no profile is logged in", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requestedUrls.push(String(input));
        expect(init?.headers).toBeUndefined();
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-"));
    const io = {
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
      env: {
        RUNWEAVE_BASE_URL: "http://127.0.0.1:5001",
        RUNWEAVE_CONFIG_FILE: path.join(dir, "missing.json"),
      },
    };

    const exitCode = await runCli(["app", "overview", "--json"], io);

    expect(exitCode).toBe(3);
    expect(requestedUrls).toEqual([
      "http://127.0.0.1:5001/api/app/home/overview",
    ]);
    expect(io.stdout.value).toBe("");
    expect(io.stderr.value).toContain("Unauthorized");
    expect(io.stderr.value).not.toContain("not logged in");
  });
});
