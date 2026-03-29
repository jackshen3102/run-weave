import { describe, expect, it, vi } from "vitest";
import { TerminalRuntimeRegistry } from "./runtime-registry";

function createRuntime() {
  return {
    pid: 123,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    signal: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("TerminalRuntimeRegistry", () => {
  it("tracks terminalSessionId to runtime mapping and attach state", () => {
    const registry = new TerminalRuntimeRegistry();
    const runtime = createRuntime();

    registry.createRuntime("terminal-1", runtime);
    registry.attachClient("terminal-1", "socket-1");

    expect(registry.getRuntime("terminal-1")).toBe(runtime);
    expect(registry.getAttachedClientCount("terminal-1")).toBe(1);

    registry.detachClient("terminal-1", "socket-1");

    expect(registry.getAttachedClientCount("terminal-1")).toBe(0);
  });

  it("disposes all runtimes during shutdown", async () => {
    const registry = new TerminalRuntimeRegistry();
    const runtimeA = createRuntime();
    const runtimeB = createRuntime();

    registry.createRuntime("terminal-1", runtimeA);
    registry.createRuntime("terminal-2", runtimeB);

    await registry.disposeAll();

    expect(runtimeA.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeB.dispose).toHaveBeenCalledTimes(1);
    expect(registry.getRuntime("terminal-1")).toBeUndefined();
    expect(registry.getRuntime("terminal-2")).toBeUndefined();
  });

  it("buffers terminal output for later replay", () => {
    const registry = new TerminalRuntimeRegistry();
    const dataListeners: Array<(data: string) => void> = [];
    const runtime = {
      pid: 123,
      onData(listener: (data: string) => void) {
        dataListeners.push(listener);
      },
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
    };

    registry.createRuntime("terminal-1", runtime);
    dataListeners[0]?.("bash-3.2$ ");

    expect(registry.getBufferedOutput("terminal-1")).toBe("bash-3.2$ ");
  });

  it("broadcasts runtime events to active subscribers and stops after unsubscribe", () => {
    const registry = new TerminalRuntimeRegistry();
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<
      (event: { exitCode: number; signal?: number }) => void
    > = [];
    const runtime = {
      pid: 123,
      onData(listener: (data: string) => void) {
        dataListeners.push(listener);
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        exitListeners.push(listener);
      },
      write: vi.fn(),
      resize: vi.fn(),
      signal: vi.fn(),
      dispose: vi.fn(),
    };
    const firstSubscriber = {
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const secondSubscriber = {
      onData: vi.fn(),
      onExit: vi.fn(),
    };

    registry.createRuntime("terminal-1", runtime);
    const unsubscribeFirst = registry.subscribe("terminal-1", firstSubscriber);
    registry.subscribe("terminal-1", secondSubscriber);

    dataListeners[0]?.("hello");
    exitListeners[0]?.({ exitCode: 0 });

    expect(firstSubscriber.onData).toHaveBeenCalledWith("hello");
    expect(secondSubscriber.onData).toHaveBeenCalledWith("hello");
    expect(firstSubscriber.onExit).toHaveBeenCalledWith({ exitCode: 0 });
    expect(secondSubscriber.onExit).toHaveBeenCalledWith({ exitCode: 0 });

    unsubscribeFirst();
    dataListeners[0]?.("again");

    expect(firstSubscriber.onData).toHaveBeenCalledTimes(1);
    expect(secondSubscriber.onData).toHaveBeenCalledTimes(2);
  });
});
