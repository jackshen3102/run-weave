export const DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT =
  "runweave:diagnostic-log-entry-visibility";

export const DIAGNOSTIC_LOG_ENTRY_STORAGE_KEY =
  "diagnostic-log-entry-enabled";

export interface DiagnosticLogEntryVisibilityController {
  enable: () => void;
  disable: () => void;
  isEnabled: () => boolean;
}

declare global {
  interface Window {
    runweaveDiagnosticLogs?: DiagnosticLogEntryVisibilityController;
  }
}

export function isDiagnosticLogEntryEnabled(): boolean {
  return localStorage.getItem(DIAGNOSTIC_LOG_ENTRY_STORAGE_KEY) === "true";
}

export function setDiagnosticLogEntryEnabled(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(DIAGNOSTIC_LOG_ENTRY_STORAGE_KEY, "true");
  } else {
    localStorage.removeItem(DIAGNOSTIC_LOG_ENTRY_STORAGE_KEY);
  }

  window.dispatchEvent(
    new CustomEvent(DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT, {
      detail: { enabled },
    }),
  );
}

export function installDiagnosticLogEntryVisibilityController(): () => void {
  const previousController = window.runweaveDiagnosticLogs;
  window.runweaveDiagnosticLogs = {
    enable: () => setDiagnosticLogEntryEnabled(true),
    disable: () => setDiagnosticLogEntryEnabled(false),
    isEnabled: isDiagnosticLogEntryEnabled,
  };

  return () => {
    window.runweaveDiagnosticLogs = previousController;
  };
}
