interface AppDiagnosticLogRecord {
  at: string;
  source: "app";
  message: string;
  details?: Record<string, unknown>;
}

interface AppDiagnosticController {
  enable: () => void;
  disable: () => void;
  clear: () => void;
  dump: () => AppDiagnosticLogRecord[];
}

declare global {
  interface Window {
    runweaveAppDiagnostics?: AppDiagnosticController;
    __RUNWEAVE_APP_DIAGNOSTICS_ENABLED__?: boolean;
    __RUNWEAVE_APP_DIAGNOSTICS__?: AppDiagnosticLogRecord[];
  }
}

function ensureDiagnosticController(): void {
  if (typeof window === "undefined" || window.runweaveAppDiagnostics) {
    return;
  }

  window.__RUNWEAVE_APP_DIAGNOSTICS__ = [];
  window.runweaveAppDiagnostics = {
    enable: () => {
      window.__RUNWEAVE_APP_DIAGNOSTICS_ENABLED__ = true;
      window.__RUNWEAVE_APP_DIAGNOSTICS__ = [];
    },
    disable: () => {
      window.__RUNWEAVE_APP_DIAGNOSTICS_ENABLED__ = false;
    },
    clear: () => {
      window.__RUNWEAVE_APP_DIAGNOSTICS__ = [];
    },
    dump: () => [...(window.__RUNWEAVE_APP_DIAGNOSTICS__ ?? [])],
  };
}

export function aiDiagnosticLog(
  message: string,
  details?: Record<string, unknown>,
): void {
  ensureDiagnosticController();
  const record: AppDiagnosticLogRecord = {
    at: new Date().toISOString(),
    source: "app",
    message,
    details,
  };
  console.debug(`[app-diagnostic] ${message}`, details);

  if (
    typeof window === "undefined" ||
    !window.__RUNWEAVE_APP_DIAGNOSTICS_ENABLED__
  ) {
    return;
  }

  window.__RUNWEAVE_APP_DIAGNOSTICS__ = [
    ...(window.__RUNWEAVE_APP_DIAGNOSTICS__ ?? []),
    record,
  ].slice(-300);
}
