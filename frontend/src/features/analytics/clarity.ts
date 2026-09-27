type ClarityQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

const SCRIPT_ID = "runweave-clarity-script";
const DEFAULT_PROJECT_ID = "yo8dc0des6";

export function initializeClarity(): void {
  const projectId = (import.meta.env.VITE_CLARITY_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  if (
    import.meta.env.VITE_CLARITY_ENABLED === "false" ||
    import.meta.env.DEV ||
    Boolean(import.meta.env.VITE_RUNWEAVE_DEV_SESSION_ID?.trim()) ||
    !projectId ||
    !/^[a-zA-Z0-9]+$/.test(projectId) ||
    !["http:", "https:"].includes(window.location.protocol) ||
    window.electronAPI?.isElectron === true ||
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
  } catch {
    // A host policy rejecting script insertion must not prevent React startup.
  }
}
