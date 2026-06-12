const ESCAPE = "\\u001b";
const BELL = "\\u0007";
const OSC_COLOR_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\]1[01];rgb:[0-9a-f/]+(?:${BELL}|${ESCAPE}\\\\)`,
  "i",
);
const DECRPM_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[\\?[0-9;]+\\$y`);
const DCS_RESPONSE_PATTERN = new RegExp(`${ESCAPE}P[01]\\$r.*${ESCAPE}\\\\`);
const CURSOR_POSITION_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]+R`);
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\[(?:\\?|>)[0-9;]+c`,
);
const FOCUS_REPORTING_RESPONSE_PATTERN = new RegExp(`${ESCAPE}\\[(?:I|O)$`);

export function isTerminalAutoResponse(data: string): boolean {
  if (!data.startsWith("\u001b")) {
    return false;
  }

  return (
    OSC_COLOR_RESPONSE_PATTERN.test(data) ||
    DECRPM_RESPONSE_PATTERN.test(data) ||
    DCS_RESPONSE_PATTERN.test(data) ||
    CURSOR_POSITION_RESPONSE_PATTERN.test(data) ||
    DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data) ||
    FOCUS_REPORTING_RESPONSE_PATTERN.test(data)
  );
}
