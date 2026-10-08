export interface TerminalInputIntent {
  kind: "browse" | "edit" | "interrupt";
  source: string;
  submit?: boolean;
}

/** Only complete, unambiguous protocol messages are exempt from draft protection.
 * Mixed/split escape sequences, history keys and bracketed paste remain edits.
 */
export function rawTerminalInputIntent(data: string): TerminalInputIntent {
  // These are terminal protocol control sequences, intentionally including ESC.
  // eslint-disable-next-line no-control-regex
  if (/^(?:\x1b\[<(?:64|65);[1-9]\d*;[1-9]\d*M)+$/.test(data))
    return { kind: "browse", source: "mouse-wheel" };
  // eslint-disable-next-line no-control-regex
  if (!data || /^(?:\x1b\[[IO]|\x1b\[\??[\d;]+R|\x1b\[(?:\?|>)[\d;]+c|\x1b\[\?[\d;]+\$y)$/.test(data))
    return { kind: "browse", source: "terminal-report" };
  if (data === "\x1b" || data === "\x03")
    return { kind: "interrupt", source: "interrupt-key" };
  return { kind: "edit", source: "raw-input", submit: data === "\r" || data === "\n" };
}
