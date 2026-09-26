import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { ConfigurationError } from "./errors";

export function assertPrivateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_ROOT_PERMISSIONS_INVALID");
}

export function assertPrivateDescriptor(fd: number, maxBytes = 1024 * 1024): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new ConfigurationError("CONFIG_FILE_NOT_PRIVATE_REGULAR");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new ConfigurationError("CONFIG_FILE_OWNER_MISMATCH");
  if (stat.mode & 0o077) throw new ConfigurationError("CONFIG_FILE_PERMISSIONS_INVALID");
  if (stat.size > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
}

export function readPrivateFile(file: string, maxBytes = 1024 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivateDescriptor(fd, maxBytes);
    const source = readFileSync(fd, "utf8");
    if (Buffer.byteLength(source) > maxBytes) throw new ConfigurationError("CONFIG_FILE_TOO_LARGE");
    return source;
  } finally { closeSync(fd); }
}
