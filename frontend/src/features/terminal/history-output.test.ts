import { describe, expect, it, vi } from "vitest";
import {
  syncTerminalHistorySize,
  writeTerminalHistoryOutput,
} from "./history-output";

describe("terminal history output", () => {
  it("fits the terminal before writing captured history", () => {
    const calls: string[] = [];
    const terminal = {
      write: vi.fn((_data: string, callback?: () => void) => {
        calls.push("write");
        callback?.();
      }),
      scrollToBottom: vi.fn(() => {
        calls.push("scrollToBottom");
      }),
    };

    writeTerminalHistoryOutput({
      terminal,
      output: "long tmux history line",
      syncSize: () => {
        calls.push("syncSize");
      },
    });

    expect(calls).toEqual(["syncSize", "write", "syncSize", "scrollToBottom"]);
    expect(terminal.write).toHaveBeenCalledWith(
      "long tmux history line",
      expect.any(Function),
    );
  });

  it("writes captured line feeds as carriage-return line feeds", () => {
    const terminal = {
      write: vi.fn(),
      scrollToBottom: vi.fn(),
    };

    writeTerminalHistoryOutput({
      terminal,
      output: "one\ntwo\r\nthree",
      syncSize: vi.fn(),
    });

    expect(terminal.write).toHaveBeenCalledWith(
      "one\r\ntwo\r\nthree",
      expect.any(Function),
    );
  });

  it("uses source columns instead of fitting to the drawer width", () => {
    const terminal = {
      rows: 24,
      resize: vi.fn(),
      refresh: vi.fn(),
    };
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    };

    syncTerminalHistorySize({
      terminal,
      fitAddon,
      sourceCols: 120,
    });

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.resize).toHaveBeenCalledWith(120, 24);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("fits to the drawer when no source columns are available", () => {
    const terminal = {
      rows: 30,
      resize: vi.fn(),
      refresh: vi.fn(),
    };
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 90, rows: 30 })),
    };

    syncTerminalHistorySize({
      terminal,
      fitAddon,
    });

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(terminal.resize).not.toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 29);
  });
});
