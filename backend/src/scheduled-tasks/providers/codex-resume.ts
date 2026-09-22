import { open } from "node:fs/promises";
import { codexAppServerClient } from "../../voice/codex-app-server-client";
import { ScheduledTaskError } from "../errors";

interface ResumeCheckpoint {
  path: string;
  offset: number;
  inode: number;
  device: number;
}

export async function checkpointCodexResume(
  threadId: string,
  cwd: string,
): Promise<ResumeCheckpoint> {
  try {
    const result = (await codexAppServerClient.sendRequest("thread/read", {
      threadId,
      includeTurns: false,
    })) as { thread?: { id?: string; path?: string; cwd?: string } };
    const thread = result.thread;
    if (thread?.id !== threadId || thread.cwd !== cwd || !thread.path)
      throw new Error("thread_identity_unavailable");
    const file = await open(thread.path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("thread_history_unavailable");
      return {
        path: thread.path,
        offset: info.size,
        inode: info.ino,
        device: info.dev,
      };
    } finally {
      await file.close();
    }
  } catch {
    throw new ScheduledTaskError(
      "thread_unavailable",
      409,
      "The original Codex thread history is unavailable",
    );
  }
}

// Codex emits this structured event after applying a resumed thread's settings.
// Read only bytes appended after this launch; an old thread/read snapshot is not
// evidence that the new interactive process restored the requested directory.
export async function confirmCodexResume(
  checkpoint: ResumeCheckpoint,
  threadId: string,
  cwd: string,
): Promise<boolean> {
  const file = await open(checkpoint.path, "r");
  try {
    const info = await file.stat();
    if (
      info.ino !== checkpoint.inode ||
      info.dev !== checkpoint.device ||
      info.size < checkpoint.offset
    )
      return false;
    const start = Math.max(checkpoint.offset, info.size - 1024 * 1024);
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > checkpoint.offset) lines.shift();
    // The final line may still be being written by Codex.
    lines.pop();
    return lines.some((line) => {
      try {
        const record = JSON.parse(line);
        return (
          record.type === "event_msg" &&
          record.payload?.type === "thread_settings_applied" &&
          record.payload.thread_id === threadId &&
          record.payload.thread_settings?.cwd === cwd
        );
      } catch {
        return false;
      }
    });
  } finally {
    await file.close();
  }
}
