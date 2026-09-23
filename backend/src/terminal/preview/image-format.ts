import path from "node:path";

export const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export function detectImageMimeType(buffer: Buffer, filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") {
    const sample = buffer
      .subarray(0, Math.min(buffer.length, 4096))
      .toString("utf8");
    if (/<svg[\s>]/i.test(sample)) {
      return "image/svg+xml";
    }
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x00010000) return "image/x-icon";
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    buffer.subarray(8, 12).toString("ascii") === "avif"
  ) {
    return "image/avif";
  }
  return null;
}
