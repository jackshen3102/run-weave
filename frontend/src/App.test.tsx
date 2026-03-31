import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useParams } from "react-router-dom";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";

vi.mock("./components/viewer-page", () => ({
  ViewerPage: ({ sessionId }: { sessionId: string }) => (
    <div>Viewer route {sessionId}</div>
  ),
}));

vi.mock("./pages/terminal-page", () => ({
  TerminalRoutePage: () => {
    const { terminalSessionId } = useParams<{ terminalSessionId: string }>();
    return <div>Terminal route {terminalSessionId}</div>;
  },
}));

function renderApp(initialPath = "/") {
  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const jsonResponse = (payload: unknown) => ({
  ok: true,
  json: async () => payload,
});

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("renders login page by default", () => {
    renderApp();

    expect(screen.getByText("Browser Viewer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
  });

  it("redirects unauthenticated viewer route to login", () => {
    renderApp("/viewer/s-1");

    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("renders viewer route when authenticated", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");

    renderApp("/viewer/s-1");

    await waitFor(() => {
      expect(screen.getByText("Viewer route s-1")).toBeInTheDocument();
    });
  });

  it("shows a proxy toggle when using managed browser in advanced settings", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/session/cdp-endpoint-default") {
          return jsonResponse({ endpoint: null });
        }
        return jsonResponse([]);
      }),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Browser" }));

    expect(screen.getByLabelText("Enable proxy")).toBeInTheDocument();
    expect(screen.queryByText(/Advanced/)).not.toBeInTheDocument();
  });

  it("shows proxy status for each session in the drawer", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            sessionId: "session-1",
            name: "CDP Playweight",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: false,
            proxyEnabled: true,
            sourceType: "connect-cdp",
            cdpEndpoint: "http://127.0.0.1:9333",
            headers: {
              "x-team": "alpha",
            },
          },
          {
            sessionId: "session-2",
            name: "Default Playweight",
            lastActivityAt: "2026-03-23T07:30:44.000Z",
            connected: false,
            proxyEnabled: false,
            sourceType: "launch",
            headers: {},
          },
        ],
      })),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    screen.getByRole("button", { name: "Sessions 2" }).click();

    await waitFor(() => {
      expect(screen.getByText("Quiet history.")).toBeInTheDocument();
    });

    expect(
      screen.getAllByText((content) => content.includes("Proxy enabled")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText((content) => content.includes("Proxy disabled")),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Attach Browser").length).toBeGreaterThan(0);
    expect(screen.getAllByText("New Browser").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText((content) => content.includes("1 header")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText((content) => content.includes("No custom headers")),
    ).toBeInTheDocument();
    expect(screen.getAllByText("CDP Playweight").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Default Playweight").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Open" }).length).toBeGreaterThan(0);
  });

  it("shows the session name in the latest session card", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            sessionId: "session-1",
            name: "CDP Playweight",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: false,
            proxyEnabled: false,
            sourceType: "connect-cdp",
            cdpEndpoint: "http://127.0.0.1:9333",
            headers: {},
          },
        ],
      })),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("Latest Session")).toBeInTheDocument();
    });

    expect(screen.getAllByText("CDP Playweight").length).toBeGreaterThan(0);
  });

  it("shows a CDP endpoint input and submits it when attaching to an existing browser", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "/api/session" && options?.method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          viewerUrl: "/?sessionId=session-1",
        });
      }
      if (url === "/api/session") {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    const endpointInput = screen.getByLabelText("CDP endpoint");
    await waitFor(() => {
      expect(endpointInput).toBeInTheDocument();
    });

    fireEvent.change(endpointInput, {
      target: { value: "http://127.0.0.1:9333" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "CDP Playweight",
            source: {
              type: "connect-cdp",
              endpoint: "http://127.0.0.1:9333",
            },
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Viewer route session-1")).toBeInTheDocument();
    });
  });

  it("submits custom session headers", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "/api/session" && options?.method === "POST") {
        return jsonResponse({
          sessionId: "session-1",
          viewerUrl: "/?sessionId=session-1",
        });
      }
      if (url === "/api/session") {
        return jsonResponse([
          {
            sessionId: "session-existing",
            name: "Default Playweight",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: false,
            proxyEnabled: false,
            sourceType: "launch",
            headers: {
              "x-team": "alpha",
            },
          },
        ]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Browser" }));

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Custom session" },
    });
    fireEvent.change(screen.getByLabelText("Request headers"), {
      target: {
        value: '{"authorization":"Bearer demo","x-team":"alpha"}',
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "Custom session",
            source: {
              type: "launch",
              proxyEnabled: false,
              headers: {
                authorization: "Bearer demo",
                "x-team": "alpha",
              },
            },
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Viewer route session-1")).toBeInTheDocument();
    });
  });

  it("requires a session name before creating a session", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "/api/session") {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      screen.getByText("Session name is required."),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          url === "/api/session" && options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("creates a terminal session from the home flow", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "/api/terminal/session" && options?.method === "POST") {
        return jsonResponse({
          terminalSessionId: "terminal-1",
          terminalUrl: "/terminal/terminal-1",
        });
      }
      if (url === "/api/session") {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Terminal" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/terminal/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    });

    expect(screen.queryByLabelText("Terminal command")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Terminal cwd")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Terminal args")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Terminal route terminal-1")).toBeInTheDocument();
    });
  });
});
