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

describe("project command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists terminal projects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/terminal/project")) {
          return Response.json([
            {
              projectId: "project-1",
              name: "Demo",
              path: "/tmp/demo",
              createdAt: "2026-06-13T00:00:00.000Z",
              isDefault: true,
            },
          ]);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const io = createIo();

    const exitCode = await runCli(["project", "list", "--json"], io);

    expect(exitCode).toBe(0);
    expect(io.stderr.value).toBe("");
    expect(JSON.parse(io.stdout.value)).toEqual([
      {
        projectId: "project-1",
        name: "Demo",
        path: "/tmp/demo",
        createdAt: "2026-06-13T00:00:00.000Z",
        isDefault: true,
      },
    ]);
  });
});
