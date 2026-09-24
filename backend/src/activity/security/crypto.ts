import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEYCHAIN_SERVICE = "com.runweave.activity";
const KEYCHAIN_ACCOUNT = "content-key-v1";
const KEY_BYTES = 32;
const SECURITY_ITEM_NOT_FOUND_STATUS = 44;

// The database initialization transaction serializes users of this key file.
// Publish a complete key atomically so a crash cannot leave a partial key.
function loadLinuxKey(activityHome: string, allowCreate: boolean): Buffer {
  const keyPath = path.join(activityHome, ".activity-content-key");
  const read = (): Buffer => {
    const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
        throw new Error("activity_content_key_permissions_invalid");
      }
      return decodeKey(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!allowCreate) throw new Error("activity_content_key_missing_restore_required");
  mkdirSync(activityHome, { recursive: true, mode: 0o700 });
  const temporary = `${keyPath}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, crypto.randomBytes(KEY_BYTES).toString("base64"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  const directory = openSync(activityHome, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return read();
}

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

function readKeychainKey(keychainPath?: string): Buffer | null {
  const result = spawnSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      ...(keychainPath ? [keychainPath] : []),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status === SECURITY_ITEM_NOT_FOUND_STATUS) return null;
  if (result.status !== 0) {
    throw new Error("activity_content_key_read_failed");
  }
  const encoded = result.stdout.trim();
  return encoded ? decodeKey(encoded) : null;
}

function resolveDefaultKeychainPath(): string | null {
  const result = spawnSync(
    "/usr/bin/security",
    ["default-keychain", "-d", "user"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return null;
  const output = result.stdout.trim();
  if (!output) return null;
  const keychainPath = output.startsWith('"') && output.endsWith('"')
    ? output.slice(1, -1)
    : output;
  return existsSync(keychainPath) ? keychainPath : null;
}

function createKeychainKey(keychainPath: string): Buffer {
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
      key.toString("base64"),
      keychainPath,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  if (result.status !== 0) {
    throw new Error("activity_content_key_create_failed");
  }
  return readKeychainKey(keychainPath) ?? key;
}

export function loadActivityContentKey(
  env: NodeJS.ProcessEnv,
  activityHome?: string,
  allowCreate = true,
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
  if (process.platform === "linux") {
    if (!activityHome) throw new Error("activity_home_required");
    return loadLinuxKey(activityHome, allowCreate);
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const existing = readKeychainKey();
  if (existing) return existing;
  const defaultKeychainPath = resolveDefaultKeychainPath();
  if (!defaultKeychainPath) {
    throw new Error("activity_default_keychain_unavailable");
  }
  return createKeychainKey(defaultKeychainPath);
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
