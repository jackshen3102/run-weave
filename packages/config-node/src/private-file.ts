import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { ConfigurationError } from "./errors";
import { assertWindowsPrivatePath, assertWindowsPrivatePathAsync } from "./windows-permissions";

function privateDirectoryStat(directory: string): Stats {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && stat.mode & 0o077 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_ROOT_PERMISSIONS_INVALID");
  return stat;
}

function privateDescriptorStat(fd: number, maxBytes: number): Stats {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new ConfigurationError("CONFIG_FILE_NOT_PRIVATE_REGULAR");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_FILE_OWNER_MISMATCH");
  if (process.platform !== "win32" && stat.mode & 0o077) throw new ConfigurationError("CONFIG_FILE_PERMISSIONS_INVALID");
  if (stat.size > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
  return stat;
}

export function assertPrivateDirectory(directory: string): void {
  privateDirectoryStat(directory);
  assertWindowsPrivatePath(directory);
}

export function assertPrivateDescriptor(fd: number, maxBytes = 1024 * 1024, file?: string): void {
  const stat = privateDescriptorStat(fd, Infinity);
  if (process.platform === "win32") {
    if (!file) throw new ConfigurationError("CONFIG_PRIVATE_PATH_REQUIRED");
    assertWindowsPrivatePath(file);
  }
  if (stat.size > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
}

function assertUnchangedPath(file: string, before: Stats): void {
  const after = lstatSync(file);
  if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs)
    throw new ConfigurationError("CONFIG_PRIVATE_PATH_CHANGED", [file]);
}

export async function assertPrivateDirectoryAsync(directory: string): Promise<void> {
  const before = privateDirectoryStat(directory);
  await assertWindowsPrivatePathAsync(directory);
  privateDirectoryStat(directory);
  assertUnchangedPath(directory, before);
}

export async function readPrivateFileAsync(file: string, maxBytes = 1024 * 1024): Promise<string> {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = privateDescriptorStat(fd, maxBytes);
    await assertWindowsPrivatePathAsync(file);
    assertUnchangedPath(file, before);
    privateDescriptorStat(fd, maxBytes);
    const source = readFileSync(fd, "utf8");
    if (Buffer.byteLength(source) > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
    return source;
  } finally { closeSync(fd); }
}

export function readPrivateFile(file: string, maxBytes = 1024 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivateDescriptor(fd, maxBytes, file);
    const source = readFileSync(fd, "utf8");
    if (Buffer.byteLength(source) > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
    return source;
  } finally { closeSync(fd); }
}
