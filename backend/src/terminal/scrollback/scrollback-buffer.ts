import { TERMINAL_PERSISTED_SCROLLBACK_BYTES } from "@runweave/shared/terminal-limits";

interface ScrollbackChunk {
  text: string;
  bytes: number;
  sequence: number;
}

export interface ScrollbackBuffer {
  chunks: ScrollbackChunk[];
  totalBytes: number;
  limitBytes: number;
  nextSequence: number;
}

function countUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function trimTextToTailBytes(value: string, limitBytes: number): string {
  if (limitBytes <= 0 || !value) {
    return "";
  }

  let start = value.length;
  let retainedBytes = 0;
  // Scan only the retained suffix. Avoid allocating/reversing a character array
  // for the entire history, and preserve lone surrogates like Array.from did.
  while (start > 0) {
    let next = start - 1;
    const unit = value.charCodeAt(next);
    let charBytes = unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
    if (unit >= 0xdc00 && unit <= 0xdfff && next > 0) {
      const previous = value.charCodeAt(next - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) {
        next -= 1;
        charBytes = 4;
      }
    }
    if (retainedBytes + charBytes > limitBytes) break;
    retainedBytes += charBytes;
    start = next;
  }
  return value.slice(start);
}

function normalizeChunk(
  text: string,
  limitBytes: number,
): Omit<ScrollbackChunk, "sequence"> | null {
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
    nextSequence: 0,
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

  buffer.chunks.push({
    ...normalized,
    sequence: buffer.nextSequence,
  });
  buffer.nextSequence += 1;
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

export function captureScrollbackBufferCursor(
  buffer: ScrollbackBuffer,
): number {
  return buffer.nextSequence;
}

export function readScrollbackBufferSince(
  buffer: ScrollbackBuffer,
  cursor: number,
): string | null {
  const firstAvailableSequence =
    buffer.chunks[0]?.sequence ?? buffer.nextSequence;
  if (cursor < firstAvailableSequence || cursor > buffer.nextSequence) {
    return null;
  }
  return buffer.chunks
    .filter((chunk) => chunk.sequence >= cursor)
    .map((chunk) => chunk.text)
    .join("");
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
