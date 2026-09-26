type ClarityQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

const SCRIPT_ID = "runweave-clarity-script";

export function initializeClarity(): void {
  const projectId = import.meta.env.VITE_CLARITY_PROJECT_ID?.trim();
  if (
    import.meta.env.VITE_CLARITY_ENABLED !== "true" ||
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
