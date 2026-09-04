import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const URL_START_REGEX = /(https?|HTTPS?):[/]{2}/;
const URL_CONTINUATION_REGEX = /^[A-Za-z0-9/?#%&=._~:+@-]+$/;
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
  columnOffset: number;
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

  const lines = collectWrappedLinkLines(terminal, lineIndex);
  if (lines.length < 2) {
    return [];
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

function collectWrappedLinkLines(
  terminal: Terminal,
  lineIndex: number,
): LinkLine[] {
  const buffer = terminal.buffer.active;
  const startIndex = findLinkStartLine(terminal, lineIndex);
  if (startIndex === null) {
    return [];
  }

  const lines: LinkLine[] = [];
  let charCount = 0;

  for (
    let index = startIndex;
    index < buffer.length &&
    lines.length < MAX_WRAPPED_LINK_LINES &&
    charCount < MAX_WRAPPED_LINK_CHARS;
    index += 1
  ) {
    const line = buffer.getLine(index);
    if (!line) {
      break;
    }

    const text = getTrimmedBufferLineText(line);
    const continuationStart = index === startIndex ? 0 : getUrlContinuationStart(text);
    if (continuationStart === null) {
      break;
    }

    const nextLine = {
      index,
      text: text.slice(continuationStart),
      columnOffset: continuationStart,
    };
    const candidateLines = [...lines, nextLine];
    const candidate = buildWrappedLinkText(candidateLines).text;
    if (index !== startIndex && !hasUrlAtEnd(candidate)) {
      break;
    }

    charCount += text.length;
    lines.push(nextLine);

    if (!hasUrlAtEnd(candidate)) {
      break;
    }
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (!firstLine || !lastLine || lineIndex < firstLine.index || lineIndex > lastLine.index) {
    return [];
  }

  return lines;
}

function findLinkStartLine(terminal: Terminal, lineIndex: number): number | null {
  let scannedChars = 0;
  const buffer = terminal.buffer.active;

  for (
    let index = lineIndex;
    index >= 0 && lineIndex - index < MAX_WRAPPED_LINK_LINES;
    index -= 1
  ) {
    const line = buffer.getLine(index);
    if (!line) {
      break;
    }

    const text = getTrimmedBufferLineText(line);
    scannedChars += text.length;
    if (scannedChars > MAX_WRAPPED_LINK_CHARS) {
      break;
    }

    if (URL_START_REGEX.test(text)) {
      return index;
    }

    if (!line.isWrapped && getUrlContinuationStart(text) === null) {
      break;
    }
  }

  return null;
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
      positions.push({ x: line.columnOffset + column + 1, y: line.index + 1 });
    }
  }

  return { text, positions };
}

function getTrimmedBufferLineText(line: IBufferLine): string {
  return line.translateToString(true).trimEnd();
}

function getUrlContinuationStart(text: string): number | null {
  const trimmed = text.trimStart();
  if (!trimmed || !URL_CONTINUATION_REGEX.test(trimmed)) {
    return null;
  }

  return text.length - trimmed.length;
}

function hasUrlAtEnd(text: string): boolean {
  URL_REGEX.lastIndex = 0;
  let match: RegExpMatchArray | null = null;
  for (const nextMatch of text.matchAll(URL_REGEX)) {
    match = nextMatch;
  }

  return match?.index !== undefined && match.index + match[0].length === text.length;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
