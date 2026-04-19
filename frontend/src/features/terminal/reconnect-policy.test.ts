import { describe, expect, it } from "vitest";
import {
  getTerminalReconnectDelay,
  MAX_TERMINAL_RECONNECT_ATTEMPTS,
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

  it("reconnects server tmux reattach closes even when they are immediate", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1012,
        livedMs: 50,
        reason: "Terminal tmux attach reattached",
      }),
    ).toBe(true);
  });

  it("does not reconnect normal closes", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1000,
        livedMs: 5_000,
      }),
    ).toBe(false);
  });

  it("does not reconnect server internal closes", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1011,
        livedMs: 5_000,
      }),
    ).toBe(false);
  });

  it("does not reconnect missing terminal runtimes", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 5_000,
        reason: "Terminal runtime not found",
      }),
    ).toBe(false);
  });

  it("does not reconnect exited terminal sessions", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 5_000,
        terminalStatus: "exited",
      }),
    ).toBe(false);
  });

  it("does not reconnect after the maximum consecutive attempts", () => {
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 5_000,
        reconnectAttempt: MAX_TERMINAL_RECONNECT_ATTEMPTS - 1,
      }),
    ).toBe(true);
    expect(
      shouldAutoReconnectTerminalClose({
        code: 1006,
        livedMs: 5_000,
        reconnectAttempt: MAX_TERMINAL_RECONNECT_ATTEMPTS,
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
