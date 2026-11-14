import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryLock } from "fs-native-extensions";

const directory = path.dirname(fileURLToPath(import.meta.url));
const writer = path.basename(directory) === "tmux"
  ? path.resolve(directory, "../../../.native-artifacts/tmux-output-writer")
  : path.join(directory, "tmux-output-writer");

export async function resolveTmuxOutputWriter(): Promise<string> {
  await access(writer, constants.X_OK);
  return writer;
}

/** Closing the descriptor releases the kernel lock, including on process exit. */
export async function lockTmuxOutputTransport(filePath: string) {
  const file = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (tryLock(file.fd)) return file;
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  return null;
}
