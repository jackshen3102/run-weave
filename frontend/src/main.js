import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/theme-provider";
import "./index.css";
createRoot(document.getElementById("root")).render(_jsx(StrictMode, { children: _jsx(ThemeProvider, { attribute: "class", defaultTheme: "system", enableSystem: true, children: _jsx(App, {}) }) }));
