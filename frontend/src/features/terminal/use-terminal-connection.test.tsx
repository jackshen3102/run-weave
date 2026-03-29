import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalConnection } from "./use-terminal-connection";

type MessageHandler = (event: { data: string }) => void;
type CloseHandler = (event: { code: number; reason: string }) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readyState = 0;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  send(): void {
    return;
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) {
      listener();
    }
  }

  emitMessage(payload: unknown): void {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get("message") ?? []) {
      (listener as MessageHandler)(event);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    const event = { code, reason };
    for (const listener of this.listeners.get("close") ?? []) {
      (listener as CloseHandler)(event);
    }
  }
}

function Probe(props: { onAuthExpired?: () => void }) {
  const connection = useTerminalConnection({
    apiBase: "http://localhost:5001",
    terminalSessionId: "terminal-1",
    token: "token-1",
    onAuthExpired: props.onAuthExpired,
  });

  return (
    <div>
      <span data-testid="connection-status">{connection.connectionStatus}</span>
      <span data-testid="terminal-status">{connection.terminalStatus ?? "unknown"}</span>
      <span data-testid="exit-code">
        {connection.exitCode == null ? "none" : String(connection.exitCode)}
      </span>
      <span data-testid="error">{connection.error ?? "none"}</span>
      <pre data-testid="output">{connection.output}</pre>
    </div>
  );
}

describe("useTerminalConnection", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("defers websocket creation so StrictMode cleanup does not close a connecting socket", () => {
    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    expect(MockWebSocket.instances).toHaveLength(0);

    act(() => {
      vi.runAllTimers();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    unmount();

    expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("tracks terminal status, exit code, and output from websocket messages", () => {
    render(<Probe />);

    act(() => {
      vi.runAllTimers();
    });

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.emitOpen();
      socket?.emitMessage({ type: "status", status: "running" });
      socket?.emitMessage({ type: "output", data: "bash-3.2$ " });
      socket?.emitMessage({ type: "exit", exitCode: 130 });
    });

    expect(screen.getByTestId("connection-status")).toHaveTextContent("connected");
    expect(screen.getByTestId("terminal-status")).toHaveTextContent("exited");
    expect(screen.getByTestId("exit-code")).toHaveTextContent("130");
    expect(screen.getByTestId("output")).toHaveTextContent("bash-3.2$");
  });

  it("clears auth state when websocket closes as unauthorized", () => {
    const onAuthExpired = vi.fn();
    render(<Probe onAuthExpired={onAuthExpired} />);

    act(() => {
      vi.runAllTimers();
    });

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.emitClose(1008, "Unauthorized");
    });

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("connection-status")).toHaveTextContent("closed");
  });
});
