import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { PiAgentContext } from "@runweave/shared/terminal/pi-agent";

/** Pi creates a file for a missing --session path, so validate before any pane respawn. */
export async function resolvePiResumeFile(
  threadId: string,
  pi?: PiAgentContext,
): Promise<string> {
  if (
    pi?.sessionId !== threadId ||
    !pi.sessionFile ||
    !path.isAbsolute(pi.sessionFile)
  )
    throw new Error("No saved Pi session file for this thread");
  const file = pi.sessionFile;
  if (path.extname(file) !== ".jsonl" || (await realpath(file)) !== file)
    throw new Error("Pi session file identity changed");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")[0]!;
    const header = JSON.parse(firstLine);
    if (
      header.type !== "session" ||
      header.version !== 3 ||
      header.id !== threadId
    )
      throw new Error("Pi session header does not match the requested thread");
    return file;
  } finally {
    await handle.close();
  }
}
