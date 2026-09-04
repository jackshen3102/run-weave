const ESCAPE = "\u001b";
const DECRQM_QUERY_RE = new RegExp(`${ESCAPE}\\[\\?[\\d;]+\\$p`, "g");
const MOUSE_TRACKING_MODES = new Set(["1000", "1002", "1003", "1005", "1006", "1015"]);
const MOUSE_TRACKING_MODE_RE = new RegExp(`${ESCAPE}\\[\\?([\\d;]+)([hl])`, "g");

export function filterBrowserHandledTerminalOutput(data: string): string {
  return data
    .replace(DECRQM_QUERY_RE, "")
    .replace(MOUSE_TRACKING_MODE_RE, (sequence, rawModes: string) => {
      const modes = rawModes.split(";");
      return modes.every((mode) => MOUSE_TRACKING_MODES.has(mode)) ? "" : sequence;
    });
}
