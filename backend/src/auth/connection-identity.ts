import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { lstat, mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { connectionProbeMessage, type ConnectionIdentity, type ConnectionProbeResponse } from "@runweave/shared/connection-identity";

/** Failure disables only identity discovery; it never silently replaces a damaged key. */
export class ConnectionIdentityService {
  private constructor(private readonly key: KeyObject | null) {}

  static async load(directory: string): Promise<ConnectionIdentityService> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, "connection-identity.json");
      try {
        await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { privateKey } = generateKeyPairSync("ed25519");
        const data = JSON.stringify({ schemaVersion: 1, privateKey: privateKey.export({ format: "jwk" }) });
        const temporary = `${file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
          await handle.close();
          // Publish a complete file without overwriting a concurrent creator's identity.
          try { await link(temporary, file); }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
        } finally {
          await handle.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
        }
      }
      const stat = await lstat(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("Invalid identity file");
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (stored.schemaVersion !== 1 || stored.privateKey?.crv !== "Ed25519" || !stored.privateKey.d) throw new Error("Invalid identity key");
      const key = createPrivateKey({ key: stored.privateKey, format: "jwk" });
      if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ format: "jwk" }).x !== stored.privateKey.x) throw new Error("Invalid identity key");
      const challenge = Buffer.from("runweave-identity-file-check-v1");
      if (!verify(null, challenge, createPublicKey(key), sign(null, challenge, key))) throw new Error("Invalid identity key pair");
      return new ConnectionIdentityService(key);
    } catch {
      return new ConnectionIdentityService(null);
    }
  }

  identity(): ConnectionIdentity | null {
    if (!this.key) return null;
    const publicKey = createPublicKey(this.key).export({ format: "jwk" }).x!;
    return { version: 1, identityId: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"), publicKey };
  }

  prove(nonce: string): ConnectionProbeResponse | null {
    const identity = this.identity();
    if (!identity || !this.key) return null;
    return { ...identity, nonce, signature: sign(null, Buffer.from(connectionProbeMessage(identity.identityId, nonce)), this.key).toString("base64url") };
  }
}
