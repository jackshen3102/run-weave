export const TERMINAL_BROWSER_DISPLAY_SCALE_STEPS = [
  0.5,
  0.67,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
] as const;

export const DEFAULT_TERMINAL_BROWSER_DISPLAY_SCALE = 1;

export interface TerminalBrowserDisplayScaleState {
  factor: number;
}

export function isTerminalBrowserDisplayScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    TERMINAL_BROWSER_DISPLAY_SCALE_STEPS.some((step) => step === value)
  );
}

export function getPreviousTerminalBrowserDisplayScale(
  factor: number,
): number | null {
  const index = TERMINAL_BROWSER_DISPLAY_SCALE_STEPS.findIndex(
    (step) => step === factor,
  );
  return index > 0 ? TERMINAL_BROWSER_DISPLAY_SCALE_STEPS[index - 1]! : null;
}

export function getNextTerminalBrowserDisplayScale(
  factor: number,
): number | null {
  const index = TERMINAL_BROWSER_DISPLAY_SCALE_STEPS.findIndex(
    (step) => step === factor,
  );
  return index >= 0 && index < TERMINAL_BROWSER_DISPLAY_SCALE_STEPS.length - 1
    ? TERMINAL_BROWSER_DISPLAY_SCALE_STEPS[index + 1]!
    : null;
}
