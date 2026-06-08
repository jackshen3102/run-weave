import { existsSync, statSync } from "node:fs";

export function isExistingDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}
