import type { AnalyticsScreen } from "./screen-classification";

type ClarityQueue = ((...args: unknown[]) => unknown) & { q?: unknown[][]; v?: string };

const SCRIPT_ID = "runweave-clarity-script";
const DEFAULT_PROJECT_ID = "yo8dc0des6";
let enabled = false;
let anonymousId: string | null = null;
let currentScreen: AnalyticsScreen | null = null;
let reportedScreen: AnalyticsScreen | null = null;
let identifying = false;
let pageGeneration = 0;

export function reportClarityDrawerOpen(drawer: "suiji" | "tunnels"): void {
  const clarity = (window as Window & { clarity?: ClarityQueue }).clarity;
  if (!enabled || !clarity?.v) return;
  try {
    clarity("event", `surface_open_${drawer}`);
  } catch {
    // Collection failures must not affect drawer interaction.
  }
}

// Keep only the latest classification while the SDK loads or restarts.
export function updateClarityScreen(screen: AnalyticsScreen | null): void {
  currentScreen = screen;
  reportScreen();
}

function reportScreen(): void {
  const clarity = (window as Window & { clarity?: ClarityQueue }).clarity;
  if (!enabled || !clarity?.v || !currentScreen || identifying || currentScreen === reportedScreen) return;
  const screen = currentScreen;
  const generation = pageGeneration;
  identifying = true;
  try {
    anonymousId ??= crypto.randomUUID();
    // The API requires a custom user ID; this random value is never persisted.
    void Promise.resolve(clarity("identify", anonymousId, undefined, screen))
      .then(() => {
        if (pageGeneration === generation) reportedScreen = screen;
      })
      .catch(() => { /* Analytics must not interrupt navigation. */ })
      .finally(() => {
        identifying = false;
        if (currentScreen !== screen || pageGeneration !== generation) reportScreen();
      });
  } catch {
    identifying = false;
  }
}

export function initializeClarity(): void {
  const projectId = (import.meta.env.VITE_CLARITY_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const isDesktop = window.electronAPI?.isElectron === true;
  const supportedProtocol = isDesktop
    ? window.location.protocol === "runweave:"
    : ["http:", "https:"].includes(window.location.protocol);
  if (
    import.meta.env.VITE_CLARITY_ENABLED === "false" ||
    import.meta.env.DEV ||
    import.meta.env.VITE_RUNWEAVE_CHANNEL === "beta" ||
    Boolean(import.meta.env.VITE_RUNWEAVE_DEV_SESSION_ID?.trim()) ||
    !projectId ||
    !/^[a-zA-Z0-9]+$/.test(projectId) ||
    !supportedProtocol ||
    window.companionAPI !== undefined ||
    document.getElementById(SCRIPT_ID)
  ) {
    return;
  }

  const clarityWindow = window as Window & { clarity?: ClarityQueue };
  // Keep the official queue protocol; the hosted script owns collection.
  if (!clarityWindow.clarity) {
    const clarity: ClarityQueue = (...args) => {
      (clarity.q ??= []).push(args);
    };
    clarityWindow.clarity = clarity;
  }

  try {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://www.clarity.ms/tag/${projectId}`;
    // Keep this marker on load failure: only a new Document should retry.
    document.head.append(script);
    enabled = true;
    // The hosted SDK recalls this callback after each SPA restart. No SDK IDs
    // are read or stored; reapply the latest fixed page ID to the new page.
    clarityWindow.clarity("metadata", () => {
      pageGeneration += 1;
      reportedScreen = null;
      reportScreen();
    }, false, true);
  } catch {
    // A host policy rejecting script insertion must not prevent React startup.
  }
}
