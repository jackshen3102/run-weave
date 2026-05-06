import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../index.js";
import { appendTokenToUrl, runTunnelCommand } from "./tunnel.js";

class FakeTunnelProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  killedSignal: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignal = signal;
    this.emit("close", 0, signal ?? null);
    return true;
  }
}

describe("tunnel command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends tunnel token to public URLs", () => {
    expect(
      appendTokenToUrl(
        "https://example.trycloudflare.com/path?existing=1",
        "token value",
      ),
    ).toBe(
      "https://example.trycloudflare.com/path?existing=1&token=token+value",
    );
  });

  it("starts cloudflared and prints a tokenized public URL", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        return new Response(null, {
          status: url.includes("token=runweave-token") ? 200 : 401,
        });
      }),
    );

    const child = new FakeTunnelProcess();
    const spawned: Array<{ command: string; args: string[] }> = [];
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const promise = runTunnelCommand(
      "start",
      [
        "--url",
        "http://localhost:5011",
        "--token",
        "runweave-token",
        "--json",
        "--no-qr",
      ],
      {
        stdout,
        stderr,
        env: {},
      },
      {
        spawn(command, args) {
          spawned.push({ command, args });
          return child;
        },
      },
    );

    child.stderr.write(
      "Visit it at https://abc-def.trycloudflare.com when ready\n",
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    child.emit("close", 0, null);

    await promise;

    expect(requestedUrls).toEqual([
      "http://localhost:5011/health",
      "http://localhost:5011/health?token=runweave-token",
    ]);
    expect(spawned).toEqual([
      {
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: [
          "--yes",
          "--package=cloudflared",
          "cloudflared",
          "tunnel",
          "--protocol",
          "http2",
          "--url",
          "http://localhost:5011",
        ],
      },
    ]);
    expect(JSON.parse(stdout.value)).toMatchObject({
      publicUrl: "https://abc-def.trycloudflare.com/?token=runweave-token",
      tunnelUrl: "https://abc-def.trycloudflare.com",
      targetUrl: "http://localhost:5011",
      qrFile: null,
      token: "runweave-token",
      tokenSource: "option",
      pid: 12345,
    });
    expect(stderr.value).toBe("");
  });

  it("writes a QR code PNG for the tokenized public URL", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runweave-cli-tunnel-"));
    try {
      const qrFile = join(tempDir, "public-url.png");
      const child = new FakeTunnelProcess();
      const stdout = {
        value: "",
        write(chunk: string) {
          this.value += chunk;
        },
      };
      const stderr = {
        value: "",
        write(chunk: string) {
          this.value += chunk;
        },
      };
      const promise = runTunnelCommand(
        "start",
        [
          "--token",
          "runweave-token",
          "--skip-check",
          "--json",
          "--qr-file",
          qrFile,
        ],
        {
          stdout,
          stderr,
          env: {},
        },
        {
          spawn() {
            return child;
          },
        },
      );

      child.stderr.write("https://qr-test.trycloudflare.com\n");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      child.emit("close", 0, null);

      await promise;

      const payload = JSON.parse(stdout.value) as { qrFile: string };
      const png = await readFile(payload.qrFile);
      expect(payload.qrFile).toBe(qrFile);
      expect([...png.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(stderr.value).toBe("");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("routes tunnel commands from the main CLI", async () => {
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const exitCode = await runCli(["tunnel"], {
      stdout: { write: vi.fn() },
      stderr,
      stdin: process.stdin,
      env: {},
    });

    expect(exitCode).toBe(2);
    expect(stderr.value).toContain("Usage: rw tunnel start");
  });

  it("requires the tunnel token to match the backend token", async () => {
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
      },
    };
    const exitCode = await runCli(["tunnel", "start"], {
      stdout: { write: vi.fn() },
      stderr,
      stdin: process.stdin,
      env: {},
    });

    expect(exitCode).toBe(2);
    expect(stderr.value).toContain("Missing tunnel token");
  });
});
