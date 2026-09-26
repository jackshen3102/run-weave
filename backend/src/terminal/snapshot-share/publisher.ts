import { settingText, type ConfigurationSnapshot } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";
import { z } from "zod";
import { SNAPSHOT_MAX_TEXT_BYTES, parseTerminalSnapshotSharePath, type CreateTerminalSnapshotShareResponse, type PublishTerminalSnapshotRequest } from "@runweave/shared/terminal/snapshot-share";
import { TerminalSnapshotShareError } from "./errors";

const responseSchema = z.object({
  sharePath: z.string().max(512),
  title: z.string().max(240),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lineCount: z.number().int().positive(),
});

export function snapshotHostOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Snapshot host must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export function createTerminalSnapshotPublisher(snapshot?: ConfigurationSnapshot): TerminalSnapshotPublisher | undefined {
  const url = snapshot ? readConfigurationPath(snapshot.value, "services.snapshotPublisher.url") : settingText("services.snapshotPublisher.url");
  const token = snapshot ? readConfigurationPath(snapshot.value, "services.snapshotPublisher.token") : settingText("services.snapshotPublisher.token");
  if (!url && !token) return undefined;
  if (typeof url !== "string" || typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("CONFIG_SNAPSHOT_PUBLISHER_INVALID");
  }
  return new TerminalSnapshotPublisher(snapshotHostOrigin(url), token);
}

export class TerminalSnapshotPublisher {
  constructor(private readonly origin: string, private readonly token: string) {}

  async publish(title: string, text: string): Promise<CreateTerminalSnapshotShareResponse> {
    if (Buffer.byteLength(text, "utf8") > SNAPSHOT_MAX_TEXT_BYTES) {
      throw new TerminalSnapshotShareError("SNAPSHOT_TOO_LARGE");
    }
    const body: PublishTerminalSnapshotRequest = { title, text };
    try {
      const response = await fetch(`${this.origin}/api/snapshot-shares`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 201) {
        await response.body?.cancel();
        const code = response.status === 413 ? "SNAPSHOT_TOO_LARGE"
          : response.status === 429 ? "SNAPSHOT_BUSY"
          : response.status === 507 ? "SNAPSHOT_STORAGE_FULL" : "SNAPSHOT_PUBLISH_FAILED";
        throw new TerminalSnapshotShareError(code);
      }
      // Bound untrusted response bodies as well as upload size. Never follow redirects with credentials.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing publish response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) throw new Error("Invalid publish response size");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const result = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const access = parseTerminalSnapshotSharePath(result.sharePath);
      const created = Date.parse(result.createdAt);
      const expires = Date.parse(result.expiresAt);
      if (!access || access.expires !== expires || expires <= Date.now() || expires - created !== 86_400_000) {
        throw new Error("Invalid publish response");
      }
      return { ...result, shareUrl: `${this.origin}${result.sharePath}` };
    } catch (error) {
      if (error instanceof TerminalSnapshotShareError) throw error;
      // Fetch errors may contain bearer URLs or upstream content; expose only a stable code.
      throw new TerminalSnapshotShareError("SNAPSHOT_PUBLISH_FAILED");
    }
  }
}
