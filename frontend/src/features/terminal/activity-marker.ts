const INITIAL_ACTIVITY_QUIET_PERIOD_MS = 1_000;
const RESIZE_ACTIVITY_QUIET_PERIOD_MS = 1_000;
const ACTIVITY_PULSE_THROTTLE_MS = 300;
const OSC_SEQUENCE_RE = new RegExp(
  String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
  "g",
);
const DCS_SEQUENCE_RE = new RegExp(String.raw`\u001bP[\s\S]*?\u001b\\`, "g");
const CSI_SEQUENCE_RE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
const ESC_SEQUENCE_RE = new RegExp(String.raw`\u001b[@-Z\\-_]`, "g");
const CONTROL_CHARS_RE = new RegExp(String.raw`[\u0000-\u001f\u007f]`, "g");

export function containsTerminalActivityContent(data: string): boolean {
  const visibleText = data
    .replace(OSC_SEQUENCE_RE, "")
    .replace(DCS_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(ESC_SEQUENCE_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .trim();

  return visibleText.length > 0;
}

export function shouldEmitTerminalActivityPulse(params: {
  now: number;
  lastMarkedAt: number | null;
}): boolean {
  if (params.lastMarkedAt === null) {
    return true;
  }

  return params.now - params.lastMarkedAt >= ACTIVITY_PULSE_THROTTLE_MS;
}

export function shouldMarkTerminalActivity(params: {
  active: boolean;
  now: number;
  openedAt: number;
  lastResizedAt: number | null;
}): boolean {
  if (params.active) {
    return false;
  }

  if (params.now - params.openedAt < INITIAL_ACTIVITY_QUIET_PERIOD_MS) {
    return false;
  }

  if (
    params.lastResizedAt !== null &&
    params.now - params.lastResizedAt < RESIZE_ACTIVITY_QUIET_PERIOD_MS
  ) {
    return false;
  }

  return true;
}
