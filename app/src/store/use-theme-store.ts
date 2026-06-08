import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "runweave-app-theme-mode";

type ThemeState = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

function readStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  return window.localStorage.getItem(STORAGE_KEY) === "light"
    ? "light"
    : "dark";
}

function persistThemeMode(mode: ThemeMode) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, mode);
}

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.classList.toggle("ion-palette-dark", mode === "dark");
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("ion-palette-light", mode === "light");
  root.style.colorScheme = mode;

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", mode === "dark" ? "#111827" : "#ffffff");
}

const initialThemeMode = readStoredThemeMode();

applyThemeMode(initialThemeMode);

export const useThemeStore = create<ThemeState>((set) => ({
  mode: initialThemeMode,
  setMode: (mode) => {
    persistThemeMode(mode);
    applyThemeMode(mode);
    set({ mode });
  },
}));
