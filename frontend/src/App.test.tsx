import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";

describe("App", () => {
  it("renders control panel title", () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <App />
      </ThemeProvider>,
    );

    expect(screen.getByText("Browser Viewer Control Panel")).toBeInTheDocument();
  });
});
