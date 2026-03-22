import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
