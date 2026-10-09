import { open } from "node:fs/promises";

export class ProviderOutputError extends Error {
  constructor(
    readonly kind: "read_failed" | "empty" | "invalid_json" | "too_large",
    readonly raw = "",
    readonly ioCode?: string,
  ) {
    // Preserve the existing single repair attempt for malformed/empty output.
    super(
      kind === "too_large"
        ? "provider_output_limit_exceeded"
        : "provider_output_invalid_json",
    );
    // Only the bounded receipt builder may inspect raw output; ordinary error
    // logging/serialization must not expose it before redaction.
    Object.defineProperty(this, "raw", { enumerable: false });
  }
}

export async function readProviderOutput(
  filename: string,
  maxBytes: number,
): Promise<unknown> {
  let raw: string;
  try {
    const file = await open(filename, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new ProviderOutputError("too_large");
      raw = buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ProviderOutputError) throw error;
    throw new ProviderOutputError(
      "read_failed",
      "",
      (error as NodeJS.ErrnoException).code,
    );
  }
  if (!raw.trim()) throw new ProviderOutputError("empty", raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderOutputError("invalid_json", raw);
  }
}
