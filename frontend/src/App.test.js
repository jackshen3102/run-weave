import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "./components/theme-provider";
import App from "./App";
describe("App", () => {
    it("renders control panel title", () => {
        render(_jsx(ThemeProvider, { attribute: "class", defaultTheme: "light", enableSystem: false, children: _jsx(App, {}) }));
        expect(screen.getByText("Browser Viewer Control Panel")).toBeInTheDocument();
    });
});
