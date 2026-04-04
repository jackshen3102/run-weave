import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../services/http";
import { useHomeTerminalPassword } from "./use-home-terminal-password";

const listTerminalSessionsMock = vi.fn();
const createTerminalSessionMock = vi.fn();
const changePasswordMock = vi.fn();

vi.mock("../../../services/terminal", () => ({
  listTerminalSessions: (...args: unknown[]) => listTerminalSessionsMock(...args),
  createTerminalSession: (...args: unknown[]) =>
    createTerminalSessionMock(...args),
}));

vi.mock("../../../services/auth", () => ({
  changePassword: (...args: unknown[]) => changePasswordMock(...args),
}));

describe("useHomeTerminalPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses an existing running terminal session before creating a new one", async () => {
    listTerminalSessionsMock.mockResolvedValue([
      {
        terminalSessionId: "terminal-1",
        status: "running",
        createdAt: "2026-04-04T12:00:00.000Z",
      },
    ]);
    const onOpenTerminalSession = vi.fn();

    const { result } = renderHook(() =>
      useHomeTerminalPassword({
        apiBase: "http://localhost:5001",
        token: "token-1",
        onAuthExpired: vi.fn(),
        onOpenTerminalSession,
      }),
    );

    await act(async () => {
      await result.current.createTerminal();
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(onOpenTerminalSession).toHaveBeenCalledWith("terminal-1");
  });

  it("surfaces incorrect current password without treating it as auth expiry", async () => {
    changePasswordMock.mockRejectedValue(
      new HttpError(403, "POST /api/auth/password failed: 403"),
    );
    const onAuthExpired = vi.fn();

    const { result } = renderHook(() =>
      useHomeTerminalPassword({
        apiBase: "http://localhost:5001",
        token: "token-1",
        onAuthExpired,
        onOpenTerminalSession: vi.fn(),
      }),
    );

    act(() => {
      result.current.openPasswordDialog();
    });

    await act(async () => {
      await result.current.changePassword({
        oldPassword: "wrong",
        newPassword: "new-password",
      });
    });

    await waitFor(() => {
      expect(result.current.passwordChangeError).toBe(
        "Incorrect current password.",
      );
    });
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});
