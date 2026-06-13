import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePort, resolveRuntimeConfig } from "./runtime-config";

const originalArgv = process.argv;
const originalEnv = { ...process.env };

function setArgv(args: string[]): void {
  process.argv = [
    originalArgv[0] ?? "node",
    originalArgv[1] ?? "server",
    ...args,
  ];
}

describe("runtime config", () => {
  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.PORT_STRICT;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  it("parses valid ports and rejects invalid values", () => {
    expect(parsePort(undefined, 5000)).toBe(5000);
    expect(parsePort(" 5173 ", 5000)).toBe(5173);

    expect(() => parsePort("0", 5000)).toThrow("Invalid PORT value");
    expect(() => parsePort("65536", 5000)).toThrow("Invalid PORT value");
    expect(() => parsePort("abc", 5000)).toThrow("Invalid PORT value");
  });

  it("prefers CLI options over environment values", () => {
    process.env.PORT = "6000";
    process.env.HOST = "0.0.0.0";
    process.env.PORT_STRICT = "false";
    setArgv(["--port=7000", "--host", "127.0.0.1"]);

    expect(resolveRuntimeConfig()).toEqual({
      preferredPort: 7000,
      strictPort: true,
      host: "127.0.0.1",
    });
  });

  it("uses environment values when CLI options are absent", () => {
    process.env.PORT = "6001";
    process.env.HOST = " 0.0.0.0 ";
    process.env.PORT_STRICT = "TRUE";
    setArgv([]);

    expect(resolveRuntimeConfig()).toEqual({
      preferredPort: 6001,
      strictPort: true,
      host: "0.0.0.0",
    });
  });

  it("falls back to defaults and ignores blank hosts", () => {
    process.env.HOST = "   ";
    process.env.PORT_STRICT = "false";
    setArgv([]);

    expect(resolveRuntimeConfig()).toEqual({
      preferredPort: 5000,
      strictPort: false,
      host: undefined,
    });
  });
});
