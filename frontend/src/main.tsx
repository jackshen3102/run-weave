import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./components/theme-provider";
import "./index.css";
import "./pwa";

const buildChannel = import.meta.env.VITE_RUNWEAVE_CHANNEL ?? "stable";
const buildRevision =
  import.meta.env.VITE_RUNWEAVE_SOURCE_REVISION ?? "unknown";
const buildVersion = import.meta.env.VITE_RUNWEAVE_VERSION ?? "unknown";

if (buildChannel === "beta") {
  const shortRevision = buildRevision.slice(0, 12);
  document.title = `Runweave Beta · ${shortRevision}`;
  document.documentElement.dataset.runweaveChannel = "beta";
  document.documentElement.dataset.runweaveSourceRevision = buildRevision;

  const badge = document.createElement("div");
  badge.dataset.runweaveBetaBadge = "true";
  badge.textContent = `BETA · ${buildVersion} · ${shortRevision}`;
  badge.setAttribute("aria-label", "Runweave Beta build identity");
  badge.style.cssText = [
    "position:fixed",
    "top:8px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "pointer-events:none",
    "border:1px solid rgba(251,191,36,.72)",
    "border-radius:999px",
    "background:rgba(69,26,3,.92)",
    "color:#fde68a",
    "padding:3px 10px",
    "font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
    "letter-spacing:.08em",
    "box-shadow:0 4px 18px rgba(0,0,0,.24)",
  ].join(";");
  document.body.append(badge);
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ThemeProvider>,
);
