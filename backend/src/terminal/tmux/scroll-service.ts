import { TmuxPaneService } from "./pane-service";
import type { TmuxPaneTarget } from "./types";
import { parseNonNegativeInteger, parsePositiveInteger } from "./internals";

export class TmuxScrollService extends TmuxPaneService {
  async readScrollState(target: TmuxPaneTarget) {
    const result = await this.runTmux(["display-message", "-p", "-t", target.paneId,
      ["#{pane_in_mode}", "#{scroll_position}", "#{mouse_any_flag}", "#{mouse_button_flag}",
        "#{mouse_standard_flag}", "#{alternate_on}", "#{pane_left}", "#{pane_top}",
        "#{pane_width}", "#{pane_height}"].join("|")], target);
    const [mode, offset, any, button, standard, alternate, left, top, width, height] = result.stdout.trim().split("|");
    const copyMode = mode === "1";
    return { copyMode, offsetRows: copyMode ? parseNonNegativeInteger(offset ?? "0") : 0,
      owner: copyMode || ![any, button, standard].includes("1") ? "history" as const : "application" as const,
      applicationMode: [any, button, standard, alternate].join(":"),
      col: parseNonNegativeInteger(left ?? "0") + Math.max(1, Math.floor(parsePositiveInteger(width ?? "1") / 2)),
      row: parseNonNegativeInteger(top ?? "0") + Math.max(1, Math.floor(parsePositiveInteger(height ?? "1") / 2)) };
  }

  async scrollHistory(target: TmuxPaneTarget, steps: number): Promise<void> {
    const scroll = ["send-keys", "-t", target.paneId, "-X", "-N", String(Math.abs(steps)), steps > 0 ? "scroll-up" : "scroll-down"];
    if (steps > 0) {
      await this.runTmux(["copy-mode", "-e", "-t", target.paneId, ";", ...scroll], target);
    } else {
      await this.runTmux(scroll, target);
    }
  }

}
