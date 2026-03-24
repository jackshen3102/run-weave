import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";

vi.mock("./components/viewer-page", () => ({
  ViewerPage: ({ sessionId }: { sessionId: string }) => (
    <div>Viewer route {sessionId}</div>
  ),
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
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Browser" }));
    fireEvent.click(screen.getByText(/Advanced/));

    expect(screen.getByLabelText("Enable proxy")).toBeInTheDocument();
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
            targetUrl: "https://www.coze.cn",
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
            targetUrl: "https://www.juejin.cn",
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
    expect(screen.getAllByText("Port 9333").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Open" }).length).toBeGreaterThan(0);
  });

  it("shows the CDP port in the latest session card for attached browsers", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            sessionId: "session-1",
            targetUrl: "https://www.coze.cn",
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

    expect(screen.getAllByText("Port 9333").length).toBeGreaterThan(0);
  });

  it("shows a CDP endpoint input and submits it when attaching to an existing browser", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "session-1",
          viewerUrl: "/?sessionId=session-1",
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
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
            url: "https://www.google.cn",
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
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            sessionId: "session-existing",
            targetUrl: "https://example.com",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: false,
            proxyEnabled: false,
            sourceType: "launch",
            headers: {
              "x-team": "alpha",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: "session-1",
          viewerUrl: "/?sessionId=session-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            sessionId: "session-existing",
            targetUrl: "https://example.com",
            lastActivityAt: "2026-03-23T07:31:19.000Z",
            connected: false,
            proxyEnabled: false,
            sourceType: "launch",
            headers: {
              "x-team": "alpha",
            },
          },
        ],
      });
    vi.stubGlobal("fetch", fetchMock);
    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Browser" }));
    fireEvent.click(screen.getByText(/Advanced/));

    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com" },
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
            url: "https://example.com",
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
});
