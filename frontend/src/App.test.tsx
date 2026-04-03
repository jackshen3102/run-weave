import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

async function renderFreshApp(initialPath = "/") {
  vi.resetModules();
  const { default: FreshApp } = await import("./App");

  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <MemoryRouter initialEntries={[initialPath]}>
        <FreshApp />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const jsonResponse = (payload: unknown) => ({
  ok: true,
  json: async () => payload,
});

const CONNECTION_AUTH_STORAGE_KEY = "viewer.auth.connection-auth";

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

  it("renders session management inline on the home page without a sessions drawer", async () => {
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

    expect(screen.queryByRole("button", { name: "Sessions 2" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open Terminal" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();

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
    expect(screen.getAllByRole("button", { name: "Rename" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Remove" }).length).toBeGreaterThan(0);
  });

  it("shows proxy and header metadata in the inline session list", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/session/cdp-endpoint-default") {
          return jsonResponse({ endpoint: null });
        }
        if (url === "/api/session") {
          return jsonResponse([
            {
              sessionId: "session-1",
              name: "Default Playweight",
              lastActivityAt: "2026-03-23T07:31:19.000Z",
              connected: false,
              proxyEnabled: true,
              sourceType: "launch",
              headers: {
                "x-team": "alpha",
              },
            },
          ]);
        }
        throw new Error(`Unhandled request: ${url}`);
      }),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getAllByText("Default Playweight").length).toBeGreaterThan(0);
    });

    expect(
      screen.getAllByText((content) => content.includes("Proxy enabled")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText((content) => content.includes("1 header")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Quiet history.")).toBeNull();
  });

  it("shows the session name in the sessions list only", async () => {
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
      expect(screen.getByText("Sessions")).toBeInTheDocument();
    });

    expect(screen.getAllByText("CDP Playweight").length).toBeGreaterThan(0);
    expect(screen.queryByText("Latest Session")).toBeNull();
  });

  it("shows a clickable connection switch entry in electron mode", async () => {
    localStorage.setItem(
      "viewer.connections",
      JSON.stringify({
        connections: [
          {
            id: "conn-1",
            name: "Local Backend",
            url: "http://127.0.0.1:4000",
            createdAt: 1,
          },
        ],
        activeId: "conn-1",
      }),
    );
    localStorage.setItem(
      CONNECTION_AUTH_STORAGE_KEY,
      JSON.stringify({
        "conn-1": {
          token: "token-conn-1",
        },
      }),
    );
    window.electronAPI = { isElectron: true, platform: "darwin" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://127.0.0.1:4000/api/auth/verify") {
          return jsonResponse({ valid: true });
        }
        if (url === "http://127.0.0.1:4000/api/session/cdp-endpoint-default") {
          return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
        }
        if (url === "http://127.0.0.1:4000/api/session") {
          return jsonResponse([]);
        }
        throw new Error(`Unhandled request: ${url}`);
      }),
    );

    await renderFreshApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /当前连接.*local backend/i }),
    ).toBeInTheDocument();
  });

  it("defaults to the built-in local development connection in electron mode", async () => {
    localStorage.setItem(
      CONNECTION_AUTH_STORAGE_KEY,
      JSON.stringify({
        "system:local-development": {
          token: "token-local-dev",
        },
      }),
    );
    window.electronAPI = {
      isElectron: true,
      platform: "darwin",
      backendUrl: "http://localhost:5002",
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "http://localhost:5002/api/auth/verify") {
        return jsonResponse({ valid: true });
      }
      if (url === "http://localhost:5002/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "http://localhost:5002/api/session") {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderFreshApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /本地开发/i }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5002/api/session",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer token-local-dev",
        },
      }),
    );
  });

  it("renders the built-in local development connection as read-only", async () => {
    localStorage.setItem(
      "viewer.connections",
      JSON.stringify({
        connections: [
          {
            id: "conn-1",
            name: "Coze 助手",
            url: "https://10.37.216.239:5012",
            createdAt: 1,
          },
        ],
        activeId: "conn-1",
      }),
    );
    window.electronAPI = {
      isElectron: true,
      platform: "darwin",
      backendUrl: "http://localhost:5002",
    };

    await renderFreshApp("/connections");

    expect(screen.getByText("本地开发")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:5002")).toBeInTheDocument();
    expect(screen.getByText("Coze 助手")).toBeInTheDocument();

    const localDevItem = screen.getByText("本地开发").closest("li");
    expect(localDevItem).not.toBeNull();
    expect(within(localDevItem as HTMLElement).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(localDevItem as HTMLElement).queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("switches connection without visiting login when the target connection token is valid", async () => {
    localStorage.setItem(
      "viewer.connections",
      JSON.stringify({
        connections: [
          {
            id: "conn-1",
            name: "Coze 助手",
            url: "https://10.37.216.239:5012",
            createdAt: 1,
          },
        ],
        activeId: "system:local-development",
      }),
    );
    localStorage.setItem(
      CONNECTION_AUTH_STORAGE_KEY,
      JSON.stringify({
        "conn-1": {
          token: "token-conn-1",
          username: "admin-user",
          password: "super-secret",
        },
      }),
    );
    window.electronAPI = {
      isElectron: true,
      platform: "darwin",
      backendUrl: "http://localhost:5002",
    };

    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "https://10.37.216.239:5012/api/auth/verify") {
        expect(options?.headers).toEqual({
          Authorization: "Bearer token-conn-1",
        });
        return jsonResponse({ valid: true });
      }
      if (url === "https://10.37.216.239:5012/api/session/cdp-endpoint-default") {
        return jsonResponse({ endpoint: "http://127.0.0.1:9333" });
      }
      if (url === "https://10.37.216.239:5012/api/session") {
        return jsonResponse([]);
      }
      throw new Error(`Unhandled request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderFreshApp("/connections");

    fireEvent.click(screen.getByRole("button", { name: /Coze 助手/i }));

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("shows the reusable connection switcher on the login page in electron mode", async () => {
    localStorage.setItem(
      "viewer.connections",
      JSON.stringify({
        connections: [
          {
            id: "conn-1",
            name: "Coze 助手",
            url: "https://10.37.216.239:5012",
            createdAt: 1,
          },
        ],
        activeId: "conn-1",
      }),
    );
    window.electronAPI = {
      isElectron: true,
      platform: "darwin",
      backendUrl: "http://localhost:5002",
    };

    await renderFreshApp("/login");

    expect(
      screen.getByRole("button", { name: /当前连接.*coze 助手/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /当前连接.*coze 助手/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("本地开发")).toBeInTheDocument();
    });
    expect(screen.getByText("连接管理")).toBeInTheDocument();
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
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
        (call) => {
          const [url, options] = call as [string, RequestInit?];
          return url === "/api/session" && options?.method === "POST";
        },
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
