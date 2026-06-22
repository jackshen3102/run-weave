import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { setupIonicReact } from "@ionic/react";

import App from "./App";

import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/padding.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/palettes/dark.class.css";
import "./theme/variables.css";
import "./main.css";
import "./store/use-theme-store";

setupIonicReact();

if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("runweave-native");
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
