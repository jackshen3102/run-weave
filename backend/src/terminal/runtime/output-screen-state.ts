import type { IBuffer, Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";

// Version-pinned adapter for @xterm/headless 6.0.0. SerializeAddon itself uses
// these internals, but omits OSC 8, margins, saved cursor, charset and cursor visibility.
// Keep all private access here, fail closed on an incompatible package upgrade.
interface Attributes {
  extended: { urlId: number };
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  getUnderlineStyle(): number;
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
  _oscLinkService: {
    getLinkData(id: number): { id?: string; uri: string } | undefined;
  };
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
    typeof value._oscLinkService?.getLinkData !== "function" ||
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
    // isUnderline() also includes OSC 8's visual underline. Persist only the
    // SGR attribute, or closing a restored link would leave plain text underlined.
    [data.getUnderlineStyle(), 4],
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

const CLOSE_LINK = "\x1b]8;;\x1b\\";

function hyperlink(state: ScreenCore, data: Attributes): string {
  const id = data.extended?.urlId;
  if (typeof id !== "number")
    throw new Error("Incompatible headless hyperlink attributes");
  if (!id) return CLOSE_LINK;
  const link = state._oscLinkService.getLinkData(id);
  if (
    !link ||
    Array.from(link.uri + (link.id ?? "")).some((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error("Cannot restore terminal hyperlink");
  return `\x1b]8;${link.id ? `id=${link.id}` : ""};${link.uri}\x1b\\`;
}

// SerializeAddon 0.14 drops OSC 8. Repaint only cells with actual link metadata,
// before restoring terminal modes/cursors. Never infer targets from visible text.
// Disable autowrap while repainting so the bottom-right cell cannot scroll.
function serializeHyperlinks(
  terminal: Terminal,
  buffer: IBuffer,
  state: ScreenCore,
): string {
  let result = "";
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    let previousId = 0;
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line?.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const data = cell as typeof cell & Attributes;
      const id = data.extended?.urlId;
      if (typeof id !== "number")
        throw new Error("Incompatible headless hyperlink cell");
      if (!id || !cell.getChars()) {
        if (previousId) result += CLOSE_LINK;
        previousId = 0;
        continue;
      }
      if (id !== previousId) {
        result += `\x1b[${row + 1};${col + 1}H` + hyperlink(state, data);
        previousId = id;
      }
      result += attributes(data) + cell.getChars();
    }
    if (previousId) result += CLOSE_LINK;
  }
  return result ? "\x1b7\x1b[?7l" + result + "\x1b[?7h\x1b8" : "";
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
  const normalLinks = serializeHyperlinks(
    terminal,
    terminal.buffer.normal,
    state,
  );
  if (terminal.buffer.active.type === "alternate") {
    // Insert normal-screen links BEFORE 1049h saves that screen. Switching back
    // afterwards would clear or overwrite the already serialized alternate screen.
    const normal = addon.serialize({
      scrollback: 0,
      excludeModes: true,
      excludeAltBuffer: true,
    });
    if (!result.startsWith(normal))
      throw new Error("Incompatible terminal screen serialization");
    result = normal + normalLinks + result.slice(normal.length);
    result += serializeHyperlinks(terminal, terminal.buffer.alternate, state);
  } else {
    result += normalLinks;
  }
  const position = (x: number, y: number) =>
    `\x1b[${y + 1};${Math.min(x, terminal.cols - 1) + 1}H`;
  result +=
    "\x1b[?6l" +
    position(buffer.savedX, Math.max(0, buffer.savedY - buffer.ybase));
  result +=
    attributes(buffer.savedCurAttrData) +
    hyperlink(state, buffer.savedCurAttrData) +
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
    result +=
      attributes(cell as typeof cell & Attributes) +
      hyperlink(state, cell as typeof cell & Attributes) +
      cell.getChars();
  }
  result +=
    attributes(state._inputHandler._curAttrData) +
    hyperlink(state, state._inputHandler._curAttrData);
  return result;
}
