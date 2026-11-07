import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { ConfigurationError } from "./errors";
import { assertWindowsPrivatePath } from "./windows-permissions";

export function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && stat.mode & 0o077 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_ROOT_PERMISSIONS_INVALID");
  assertWindowsPrivatePath(directory);
}

export function assertPrivateDescriptor(fd: number, maxBytes = 1024 * 1024, file?: string): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new ConfigurationError("CONFIG_FILE_NOT_PRIVATE_REGULAR");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_FILE_OWNER_MISMATCH");
  if (process.platform !== "win32" && stat.mode & 0o077) throw new ConfigurationError("CONFIG_FILE_PERMISSIONS_INVALID");
  if (process.platform === "win32") {
    if (!file) throw new ConfigurationError("CONFIG_PRIVATE_PATH_REQUIRED");
    assertWindowsPrivatePath(file);
  }
  if (stat.size > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
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
