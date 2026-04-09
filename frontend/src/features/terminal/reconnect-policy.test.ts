import { describe, expect, it } from "vitest";
import {
  getTerminalReconnectDelay,
  shouldAutoReconnectTerminalClose,
} from "./reconnect-policy";

describe("shouldAutoReconnectTerminalClose", () => {
  it("reconnects a healthy connection after an unexpected close", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 5_000,
      }),
    ).toBe(true);
  });

  it("does not reconnect policy closes", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1008,
        livedMs: 5_000,
      }),
    ).toBe(false);
  });

  it("does not reconnect sockets that die immediately", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 500,
      }),
    ).toBe(false);
  });
});

describe("getTerminalReconnectDelay", () => {
  it("uses exponential backoff capped at five seconds", () => {
    expect(getTerminalReconnectDelay(0)).toBe(250);
    expect(getTerminalReconnectDelay(1)).toBe(500);
    expect(getTerminalReconnectDelay(4)).toBe(4_000);
    expect(getTerminalReconnectDelay(6)).toBe(5_000);
  });
});
