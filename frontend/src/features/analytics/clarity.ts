import { beginDiagnosticAction, diagnosticLaunchId, setActionDiagnosticEmitter } from "../../lib/action-diagnostics";
import { runtimeBuildInfo } from "@runweave/shared/runtime-version";
import type { AnalyticsScreen } from "./screen-classification";
import { installDesktopClarityCookies } from "./desktop-clarity-cookies";

type ClarityQueue = ((...args: unknown[]) => unknown) & { q?: unknown[][]; v?: string };

const SCRIPT_ID = "runweave-clarity-script";
const DEFAULT_PROJECT_ID = "yo8dc0des6";
let enabled = false;
let anonymousId: string | null = null;
let currentScreen: AnalyticsScreen | null = null;
let reportedScreen: AnalyticsScreen | null = null;
let identifying = false;
let pageGeneration = 0;
let sdkStarted = false;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastRecoveryAt = -Infinity;

function scheduleClarityRecovery(): void {
  const clarity = (window as Window & { clarity?: ClarityQueue }).clarity;
  if (!enabled || !sdkStarted || clarity?.v || !clarity || recoveryTimer !== null ||
    document.visibilityState !== "visible" || !navigator.onLine || Date.now() - lastRecoveryAt < 30_000) return;
  // Normal SPA restarts briefly remove v. Only recover a stopped SDK after
  // another foreground action, never from an autonomous retry loop.
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    const current = (window as Window & { clarity?: ClarityQueue }).clarity;
    if (!current || current.v || document.visibilityState !== "visible" || !navigator.onLine) return;
    lastRecoveryAt = Date.now();
    try { current("start"); } catch { /* Analytics must not interrupt interaction. */ }
  }, 1_000);
}

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
  scheduleClarityRecovery();
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
  const initialization = beginDiagnosticAction("analytics");
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
    initialization.stage("rejected");
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
    if (isDesktop) installDesktopClarityCookies();
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://www.clarity.ms/tag/${projectId}`;
    // Keep this marker on load failure: only a new Document should retry.
    document.head.append(script);
    enabled = true;
    setActionDiagnosticEmitter((event) => {
      const current = (window as Window & { clarity?: ClarityQueue }).clarity;
      if (enabled && current?.v) current("event", event);
    });
    script.addEventListener("error", () => beginDiagnosticAction("analytics").stage("failed"), { once: true });
    window.addEventListener("online", scheduleClarityRecovery);
    window.addEventListener("focus", scheduleClarityRecovery);
    window.addEventListener("pointerdown", scheduleClarityRecovery, { capture: true, passive: true });
    document.addEventListener("visibilitychange", scheduleClarityRecovery);
    // The hosted SDK recalls this callback after each SPA restart. Reapply the
    // latest fixed page ID without retaining the callback's metadata.
    clarityWindow.clarity("metadata", () => {
      sdkStarted = true;
      const build = runtimeBuildInfo();
      const tags = { diagnostic_launch_id: diagnosticLaunchId,
        client: isDesktop ? "desktop" : "web", environment: projectId === DEFAULT_PROJECT_ID ? "production" : "qa",
        app_version: build.version, build_id: build.buildId ?? "unknown",
        source_revision: build.sourceRevision ?? "unknown" };
      try {
        for (const [key, value] of Object.entries(tags)) clarityWindow.clarity?.("set", key, value);
        beginDiagnosticAction("analytics").stage("confirmed");
      } catch { beginDiagnosticAction("analytics").stage("failed"); }
      pageGeneration += 1;
      reportedScreen = null;
      reportScreen();
    }, false, true);
  } catch {
    // A host policy rejecting script insertion must not prevent React startup.
  }
}
