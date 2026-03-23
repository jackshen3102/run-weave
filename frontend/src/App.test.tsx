import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";

function renderApp() {
  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <App />
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

  it("shows a proxy toggle on the create-session form for authenticated users", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });
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
            profileMode: "custom",
          },
          {
            sessionId: "session-2",
            targetUrl: "https://www.juejin.cn",
            lastActivityAt: "2026-03-23T07:30:44.000Z",
            connected: false,
            proxyEnabled: false,
            profileMode: "managed",
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

    expect(screen.getAllByText("Proxy enabled").length).toBeGreaterThan(0);
    expect(screen.getByText("Proxy disabled")).toBeInTheDocument();
    expect(screen.getAllByText("Custom profile").length).toBeGreaterThan(0);
    expect(screen.getByText("Managed profile")).toBeInTheDocument();
  });

  it("shows a custom profile path input and submits it", async () => {
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
    const assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignMock },
      writable: true,
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Use custom profile path"));

    const profilePathInput = screen.getByLabelText("Profile path");
    await waitFor(() => {
      expect(profilePathInput).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Target URL"), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(profilePathInput, {
      target: { value: "/profiles/custom-profile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            url: "https://example.com",
            proxyEnabled: false,
            profilePath: "/profiles/custom-profile",
          }),
        }),
      );
    });
    expect(assignMock).toHaveBeenCalledWith("/?sessionId=session-1");
  });
});
