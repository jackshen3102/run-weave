import { describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT,
  isDiagnosticLogEntryEnabled,
  setDiagnosticLogEntryEnabled,
} from "./entry-visibility";

describe("diagnostic log entry visibility", () => {
  it("is disabled by default", () => {
    localStorage.removeItem("diagnostic-log-entry-enabled");

    expect(isDiagnosticLogEntryEnabled()).toBe(false);
  });

  it("persists enabled state and dispatches a visibility event", () => {
    const listener = vi.fn();
    window.addEventListener(DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT, listener);

    setDiagnosticLogEntryEnabled(true);

    expect(isDiagnosticLogEntryEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { enabled: true },
    });

    window.removeEventListener(DIAGNOSTIC_LOG_ENTRY_VISIBILITY_EVENT, listener);
  });

  it("removes enabled state when disabled", () => {
    setDiagnosticLogEntryEnabled(true);

    setDiagnosticLogEntryEnabled(false);

    expect(isDiagnosticLogEntryEnabled()).toBe(false);
  });
});
