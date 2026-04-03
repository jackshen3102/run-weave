import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRoutePage } from "./terminal-page";

const navigateMock = vi.fn();
const terminalWorkspacePropsSpy = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../components/terminal/terminal-workspace", () => ({
  TerminalWorkspace: (props: unknown) => {
    terminalWorkspacePropsSpy(props);
    return <div data-testid="terminal-workspace" />;
  },
}));

describe("TerminalRoutePage", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    terminalWorkspacePropsSpy.mockReset();
  });

  it("navigates home when the workspace confirms no terminal is available", () => {
    render(
      <MemoryRouter initialEntries={["/terminal/terminal-1"]}>
        <Routes>
          <Route
            path="/terminal/:terminalSessionId"
            element={
              <TerminalRoutePage
                apiBase="http://localhost:5000"
                token="token-1"
                onAuthExpired={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const props = terminalWorkspacePropsSpy.mock.calls[0]?.[0] as {
      onNoSessionAvailable?: () => void;
    };
    props.onNoSessionAvailable?.();

    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("does not navigate when the workspace stays on the current route after a load failure", () => {
    render(
      <MemoryRouter initialEntries={["/terminal/terminal-1"]}>
        <Routes>
          <Route
            path="/terminal/:terminalSessionId"
            element={
              <TerminalRoutePage
                apiBase="http://localhost:5000"
                token="token-1"
                onAuthExpired={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const props = terminalWorkspacePropsSpy.mock.calls[0]?.[0] as {
      onActiveSessionChange?: (terminalSessionId: string) => void;
      onNoSessionAvailable?: () => void;
    };

    expect(props.onNoSessionAvailable).toBeTypeOf("function");
    props.onActiveSessionChange?.("terminal-1");

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uses tighter bottom spacing so the terminal is not clipped", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/terminal/terminal-1"]}>
        <Routes>
          <Route
            path="/terminal/:terminalSessionId"
            element={
              <TerminalRoutePage
                apiBase="http://localhost:5000"
                token="token-1"
                onAuthExpired={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(container.querySelector("main")).toHaveClass("px-3", "pt-3", "pb-2");
  });
});
