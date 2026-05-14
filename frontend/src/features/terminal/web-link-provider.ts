import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const MAX_WRAPPED_LINK_LINES = 32;
const MAX_WRAPPED_LINK_CHARS = 4096;

interface TerminalLinkProviderOptions {
  activate: (event: MouseEvent, uri: string) => void;
}

interface TextCellPosition {
  x: number;
  y: number;
}

interface LinkLine {
  index: number;
  text: string;
}

export function createTerminalWrappedWebLinkProvider(
  terminal: Terminal,
  options: TerminalLinkProviderOptions,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const links = computeTerminalWebLinks(
        terminal,
        bufferLineNumber,
        options.activate,
      );
      callback(links.length > 0 ? links : undefined);
    },
  };
}

function computeTerminalWebLinks(
  terminal: Terminal,
  bufferLineNumber: number,
  activate: TerminalLinkProviderOptions["activate"],
): ILink[] {
  const lineIndex = bufferLineNumber - 1;
  const buffer = terminal.buffer.active;
  const requestedLine = buffer.getLine(lineIndex);
  if (!requestedLine) {
    return [];
  }

  const startIndex = findWrappedLinkStart(terminal, lineIndex);
  const endIndex = findWrappedLinkEnd(terminal, lineIndex);
  if (startIndex === endIndex) {
    return [];
  }

  const lines: LinkLine[] = [];
  let charCount = 0;

  for (
    let index = startIndex;
    index <= endIndex &&
    lines.length < MAX_WRAPPED_LINK_LINES &&
    charCount < MAX_WRAPPED_LINK_CHARS;
    index += 1
  ) {
    const line = buffer.getLine(index);
    if (!line) {
      break;
    }
    const text = line.translateToString(true);
    charCount += text.length;
    lines.push({ index, text });
  }

  const { text, positions } = buildWrappedLinkText(lines);
  const links: ILink[] = [];
  URL_REGEX.lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const uri = match[0];
    if (!isValidHttpUrl(uri) || match.index === undefined) {
      continue;
    }

    const firstPosition = positions[match.index];
    const lastPosition = positions[match.index + uri.length - 1];
    if (!firstPosition || !lastPosition) {
      continue;
    }
    if (
      bufferLineNumber < firstPosition.y ||
      bufferLineNumber > lastPosition.y
    ) {
      continue;
    }
    if (firstPosition.y === lastPosition.y) {
      continue;
    }

    links.push({
      range: {
        start: firstPosition,
        end: lastPosition,
      },
      text: uri,
      activate: (event) => {
        event.preventDefault();
        activate(event, uri);
      },
    });
  }

  return links;
}

function findWrappedLinkStart(terminal: Terminal, lineIndex: number): number {
  let startIndex = lineIndex;
  let scannedChars = 0;
  const buffer = terminal.buffer.active;

  while (startIndex > 0 && scannedChars < MAX_WRAPPED_LINK_CHARS) {
    const currentLine = buffer.getLine(startIndex);
    if (!currentLine?.isWrapped) {
      break;
    }

    const previousLine = buffer.getLine(startIndex - 1);
    scannedChars += previousLine?.translateToString(true).length ?? 0;
    startIndex -= 1;
  }

  return startIndex;
}

function findWrappedLinkEnd(terminal: Terminal, lineIndex: number): number {
  let endIndex = lineIndex;
  let scannedChars = 0;
  const buffer = terminal.buffer.active;

  while (
    endIndex + 1 < buffer.length &&
    scannedChars < MAX_WRAPPED_LINK_CHARS
  ) {
    const nextLine = buffer.getLine(endIndex + 1);
    if (!nextLine?.isWrapped) {
      break;
    }

    scannedChars += nextLine.translateToString(true).length;
    endIndex += 1;
  }

  return endIndex;
}

function buildWrappedLinkText(lines: LinkLine[]): {
  text: string;
  positions: Array<TextCellPosition | null>;
} {
  let text = "";
  const positions: Array<TextCellPosition | null> = [];

  for (let lineOffset = 0; lineOffset < lines.length; lineOffset += 1) {
    const line = lines[lineOffset];
    if (!line) {
      continue;
    }

    for (let column = 0; column < line.text.length; column += 1) {
      text += line.text[column];
      positions.push({ x: column + 1, y: line.index + 1 });
    }
  }

  return { text, positions };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
