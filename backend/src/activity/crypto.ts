import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEYCHAIN_SERVICE = "com.runweave.activity";
const KEYCHAIN_ACCOUNT = "content-key-v1";
const KEY_BYTES = 32;

export interface ActivityEncryptedValue {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: typeof KEYCHAIN_ACCOUNT;
  keyVersion: 1;
}

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("activity_content_key_invalid");
  }
  return key;
}

function readKeychainKey(): Buffer | null {
  const result = spawnSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? decodeKey(result.stdout) : null;
}

function createKeychainKey(): Buffer {
  const key = crypto.randomBytes(KEY_BYTES);
  const result = spawnSync(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ],
    {
      encoding: "utf8",
      input: `${key.toString("base64")}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  if (result.status !== 0) {
    throw new Error("activity_content_key_create_failed");
  }
  return readKeychainKey() ?? key;
}

export function loadActivityContentKey(
  env: NodeJS.ProcessEnv,
  activityHome?: string,
): Buffer | null {
  if (env.RUNWEAVE_ACTIVITY_TEST_MODE === "true") {
    const configured = env.RUNWEAVE_ACTIVITY_TEST_KEY?.trim();
    if (configured) {
      return decodeKey(configured);
    }
    if (!activityHome) throw new Error("activity_test_home_required");
    const keyPath = path.join(activityHome, ".activity-test-key");
    mkdirSync(activityHome, { recursive: true, mode: 0o700 });
    try {
      return decodeKey(readFileSync(keyPath, "utf8"));
    } catch {
      const created = crypto.randomBytes(KEY_BYTES);
      try {
        writeFileSync(keyPath, created.toString("base64"), {
          mode: 0o600,
          flag: "wx",
        });
        return created;
      } catch {
        return decodeKey(readFileSync(keyPath, "utf8"));
      }
    }
  }
  if (process.platform !== "darwin") {
    return null;
  }
  return readKeychainKey() ?? createKeychainKey();
}

export async function loadActivityEncryptionKey(params: {
  activityHome: string;
  testMode: boolean;
}): Promise<Buffer | null> {
  return loadActivityContentKey(
    {
      ...process.env,
      RUNWEAVE_ACTIVITY_TEST_MODE: params.testMode ? "true" : "false",
    },
    params.activityHome,
  );
}

export function encryptActivityValue(
  plaintext: Buffer,
  key: Buffer,
): ActivityEncryptedValue {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyId: KEYCHAIN_ACCOUNT,
    keyVersion: 1,
  };
}

export function decryptActivityValue(
  encrypted: Pick<ActivityEncryptedValue, "ciphertext" | "nonce" | "authTag">,
  key: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.nonce);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
}

export function deriveAuditSubjectHmac(
  username: string,
  key: Buffer,
): string {
  const auditKey = crypto.hkdfSync(
    "sha256",
    key,
    Buffer.alloc(0),
    Buffer.from("runweave/activity-audit-subject/v1"),
    32,
  );
  return crypto
    .createHmac("sha256", Buffer.from(auditKey))
    .update(username)
    .digest("hex");
}
