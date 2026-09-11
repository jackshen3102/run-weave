import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

// Version-pinned adapter for @xterm/headless 6.0.0. SerializeAddon itself uses
// these internals, but omits margins, saved cursor, charset and cursor visibility.
// Keep all private access here, fail closed on an incompatible package upgrade.
interface Attributes {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}
type Charset = Record<string, string> | undefined;
interface ScreenBuffer {
  x: number;
  y: number;
  ybase: number;
  scrollTop: number;
  scrollBottom: number;
  savedX: number;
  savedY: number;
  savedCurAttrData: Attributes;
  savedCharset: Charset;
  tabs: Record<number, boolean>;
}
interface ScreenCore {
  _inputHandler: {
    _parser: { currentState: number };
    _curAttrData: Attributes;
  };
  _bufferService: { buffer: ScreenBuffer };
  _charsetService: { charset: Charset; glevel: number; _charsets: Charset[] };
  coreService: { isCursorHidden: boolean };
  coreMouseService: { activeEncoding: string };
}
function core(terminal: Terminal): ScreenCore {
  const value = (terminal as unknown as { _core: ScreenCore })._core;
  if (
    typeof value?._inputHandler?._parser?.currentState !== "number" ||
    !value._bufferService.buffer?.savedCurAttrData ||
    !value._charsetService
  )
    throw new Error("Incompatible headless terminal state");
  return value;
}

export function screenParserIsIdle(terminal: Terminal): boolean {
  return core(terminal)._inputHandler._parser.currentState === 0;
}

function attributes(data: Attributes): string {
  const codes = [0];
  for (const [enabled, code] of [
    [data.isBold(), 1],
    [data.isDim(), 2],
    [data.isItalic(), 3],
    [data.isUnderline(), 4],
    [data.isBlink(), 5],
    [data.isInverse(), 7],
    [data.isInvisible(), 8],
    [data.isStrikethrough(), 9],
  ])
    if (enabled) codes.push(code!);
  for (const foreground of [true, false]) {
    const color = foreground ? data.getFgColor() : data.getBgColor();
    if (foreground ? data.isFgRGB() : data.isBgRGB())
      codes.push(
        foreground ? 38 : 48,
        2,
        (color >>> 16) & 255,
        (color >>> 8) & 255,
        color & 255,
      );
    else if (foreground ? data.isFgPalette() : data.isBgPalette())
      codes.push(foreground ? 38 : 48, 5, color);
  }
  return `\x1b[${codes.join(";")}m`;
}

function charsetCode(charset: Charset): string {
  if (!charset) return "B";
  if (charset.q === "─") return "0";
  if (Object.keys(charset).length === 1 && charset["#"] === "£") return "A";
  throw new Error("Unsupported terminal charset for snapshot");
}

export function serializeOutputScreen(
  terminal: Terminal,
  addon: SerializeAddon,
): string {
  const state = core(terminal);
  const buffer = state._bufferService.buffer;
  // Serialize both screens first in default coordinates; set origin mode last
  // because DECSET 6 moves the cursor. Snapshot consumers reset before feeding.
  let result = addon.serialize({ scrollback: 0, excludeModes: true });
  const position = (x: number, y: number) =>
    `\x1b[${y + 1};${Math.min(x, terminal.cols - 1) + 1}H`;
  result +=
    "\x1b[?6l" +
    position(buffer.savedX, Math.max(0, buffer.savedY - buffer.ybase));
  result +=
    attributes(buffer.savedCurAttrData) +
    `\x1b(${charsetCode(buffer.savedCharset)}\x0f\x1b7`;
  // Recreate tab stops without printing or affecting the screen cells.
  result += "\x1b[3g";
  for (const column of Object.keys(buffer.tabs)) {
    if (buffer.tabs[Number(column)])
      result += position(Number(column), 0) + "\x1bH";
  }
  result += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  const modes = terminal.modes;
  for (const [enabled, code] of [
    [modes.applicationCursorKeysMode, 1],
    [modes.applicationKeypadMode, 66],
    [modes.bracketedPasteMode, 2004],
    [modes.originMode, 6],
    [modes.reverseWraparoundMode, 45],
    [modes.sendFocusMode, 1004],
    [modes.wraparoundMode, 7],
    [!state.coreService.isCursorHidden, 25],
  ] as const)
    result += `\x1b[?${code}${enabled ? "h" : "l"}`;
  if (modes.insertMode) result += "\x1b[4h";
  const mouse = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[
    modes.mouseTrackingMode
  ];
  if (mouse) result += `\x1b[?${mouse}h`;
  if (state.coreMouseService.activeEncoding === "SGR") result += "\x1b[?1006h";
  const charset = state._charsetService;
  for (let index = 0; index < 4; index++)
    result += `\x1b${"()*+"[index]}${charsetCode(charset._charsets[index])}`;
  result +=
    charset.glevel === 1
      ? "\x0e"
      : charset.glevel === 2
        ? "\x1bn"
        : charset.glevel === 3
          ? "\x1bo"
          : "\x0f";
  result += position(
    buffer.x,
    buffer.y - (modes.originMode ? buffer.scrollTop : 0),
  );
  if (buffer.x >= terminal.cols) {
    const line = terminal.buffer.active.getLine(
      terminal.buffer.active.baseY + buffer.y,
    );
    let column = terminal.cols - 1;
    if (line?.getCell(column)?.getWidth() === 0) column--;
    const cell = line?.getCell(column);
    if (!cell?.getChars())
      throw new Error("Cannot restore terminal wrap position");
    result += position(
      column,
      buffer.y - (modes.originMode ? buffer.scrollTop : 0),
    );
    result += attributes(cell) + cell.getChars();
  }
  result += attributes(state._inputHandler._curAttrData);
  return result;
}
