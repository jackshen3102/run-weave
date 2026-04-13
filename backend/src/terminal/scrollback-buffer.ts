import { TERMINAL_PERSISTED_SCROLLBACK_BYTES } from "@browser-viewer/shared";

interface ScrollbackChunk {
  text: string;
  bytes: number;
}

export interface ScrollbackBuffer {
  chunks: ScrollbackChunk[];
  totalBytes: number;
  limitBytes: number;
}

function countUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function trimTextToTailBytes(value: string, limitBytes: number): string {
  if (limitBytes <= 0 || !value) {
    return "";
  }

  let retained = "";
  let retainedBytes = 0;
  for (const char of Array.from(value).reverse()) {
    const charBytes = countUtf8Bytes(char);
    if (retainedBytes + charBytes > limitBytes) {
      break;
    }
    retained = `${char}${retained}`;
    retainedBytes += charBytes;
  }

  return retained;
}

function normalizeChunk(
  text: string,
  limitBytes: number,
): ScrollbackChunk | null {
  if (!text || limitBytes <= 0) {
    return null;
  }

  const bytes = countUtf8Bytes(text);
  if (bytes <= limitBytes) {
    return { text, bytes };
  }

  const trimmed = trimTextToTailBytes(text, limitBytes);
  if (!trimmed) {
    return null;
  }

  return {
    text: trimmed,
    bytes: countUtf8Bytes(trimmed),
  };
}

export function createScrollbackBuffer(
  initial = "",
  limitBytes = TERMINAL_PERSISTED_SCROLLBACK_BYTES,
): ScrollbackBuffer {
  const buffer: ScrollbackBuffer = {
    chunks: [],
    totalBytes: 0,
    limitBytes,
  };

  appendToScrollbackBuffer(buffer, initial);
  return buffer;
}

export function appendToScrollbackBuffer(
  buffer: ScrollbackBuffer,
  chunk: string,
): void {
  const normalized = normalizeChunk(chunk, buffer.limitBytes);
  if (!normalized) {
    return;
  }

  buffer.chunks.push(normalized);
  buffer.totalBytes += normalized.bytes;

  while (buffer.totalBytes > buffer.limitBytes && buffer.chunks.length > 0) {
    const removed = buffer.chunks.shift();
    if (!removed) {
      break;
    }
    buffer.totalBytes -= removed.bytes;
  }
}

export function readScrollbackBuffer(buffer: ScrollbackBuffer): string {
  return buffer.chunks.map((chunk) => chunk.text).join("");
}

export function readScrollbackBufferTailLines(
  buffer: ScrollbackBuffer,
  maxLines: number,
): string {
  if (maxLines <= 0 || buffer.chunks.length === 0) {
    return "";
  }

  const tailParts: string[] = [];
  let lineBreaks = 0;

  for (
    let chunkIndex = buffer.chunks.length - 1;
    chunkIndex >= 0;
    chunkIndex -= 1
  ) {
    const text = buffer.chunks[chunkIndex]?.text ?? "";
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (text[index] !== "\n") {
        continue;
      }

      lineBreaks += 1;
      if (lineBreaks >= maxLines) {
        const tail = text.slice(index + 1);
        if (tail) {
          tailParts.push(tail);
        }
        return tailParts.reverse().join("");
      }
    }
    tailParts.push(text);
  }

  return tailParts.reverse().join("");
}
