import { nativeImage } from "electron";
import {
  getTerminalBrowserSession,
  type TerminalBrowserEntry,
} from "./terminal-browser-runtime.js";

const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_FAVICON_DIMENSION = 512;
const FAVICON_SIZE = 16;
const FAVICON_FETCH_TIMEOUT_MS = 5_000;
const SAFE_IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

function safeFaviconCandidate(candidate: string): URL | "data" | null {
  if (candidate.startsWith("data:")) {
    return /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(candidate)
      ? "data"
      : null;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function readLimitedResponse(response: Response): Promise<Buffer | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FAVICON_BYTES) {
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > MAX_FAVICON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

async function loadFaviconBytes(candidate: string): Promise<Buffer | null> {
  const safeCandidate = safeFaviconCandidate(candidate);
  if (!safeCandidate) {
    return null;
  }
  if (safeCandidate === "data") {
    const encoded = candidate.slice(candidate.indexOf(",") + 1);
    if (encoded.length > Math.ceil((MAX_FAVICON_BYTES * 4) / 3) + 4) {
      return null;
    }
    const bytes = Buffer.from(encoded, "base64");
    return bytes.byteLength <= MAX_FAVICON_BYTES ? bytes : null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT_MS);
  try {
    const response = await getTerminalBrowserSession().fetch(
      safeCandidate.toString(),
      { signal: controller.signal },
    );
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (!response.ok || !contentType || !SAFE_IMAGE_CONTENT_TYPES.has(contentType)) {
      return null;
    }
    return await readLimitedResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeFavicon(bytes: Buffer): string | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) {
    return null;
  }
  const size = image.getSize();
  if (
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_FAVICON_DIMENSION ||
    size.height > MAX_FAVICON_DIMENSION
  ) {
    return null;
  }
  const sanitized = image.resize({
    width: FAVICON_SIZE,
    height: FAVICON_SIZE,
    quality: "best",
  });
  return sanitized.isEmpty() ? null : sanitized.toDataURL();
}

export async function updateTerminalBrowserFavicon(
  entry: TerminalBrowserEntry,
  candidates: string[],
  generation: number,
  onChanged: () => void,
): Promise<void> {
  for (const candidate of candidates) {
    try {
      const bytes = await loadFaviconBytes(candidate);
      const faviconDataUrl = bytes ? sanitizeFavicon(bytes) : null;
      if (!faviconDataUrl) {
        continue;
      }
      if (
        entry.faviconGeneration !== generation ||
        entry.view.webContents.isDestroyed()
      ) {
        return;
      }
      if (entry.faviconDataUrl !== faviconDataUrl) {
        entry.faviconDataUrl = faviconDataUrl;
        onChanged();
      }
      return;
    } catch {
      // Favicon failures are visual fallbacks, not navigation failures.
    }
  }
}
