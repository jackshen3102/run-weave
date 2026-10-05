import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CreateTerminalClipboardFileResponse } from "@runweave/shared/terminal/input";

export async function saveTerminalClipboardFile(
  terminalSessionId: string,
  fileName: string,
  data: Buffer,
): Promise<CreateTerminalClipboardFileResponse> {
  const directory = path.join(os.tmpdir(), "runweave-terminal-files", terminalSessionId, randomUUID());
  const filePath = path.join(directory, fileName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, data, { mode: 0o600, flag: "wx" });
    return { fileName, filePath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
