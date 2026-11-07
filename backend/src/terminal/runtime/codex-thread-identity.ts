import { codexAppServerClient } from "../../voice/codex-app-server-client";

const identities = new Map<string, Promise<boolean | null>>();

/** Only a persisted, non-child thread can own a legacy terminal's conversation. */
export function isCodexConversationThread(threadId: string): Promise<boolean | null> {
  const cached = identities.get(threadId);
  if (cached) return cached;
  const pending = readIdentity(threadId).then((result) => {
    // Failures and absent sources may recover; do not retain negative lookups.
    if (result !== true && identities.get(threadId) === pending) identities.delete(threadId);
    return result;
  });
  identities.set(threadId, pending);
  if (identities.size > 256) identities.delete(identities.keys().next().value!);
  return pending;
}

async function readIdentity(threadId: string): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      codexAppServerClient.sendRequest("thread/read", { threadId, includeTurns: false }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]) as { thread?: { id?: string; ephemeral?: boolean; parentThreadId?: string | null;
      source?: unknown; path?: string | null } } | null;
    const thread = response?.thread;
    if (!thread || thread.id !== threadId) return null;
    if (thread.ephemeral === true || thread.parentThreadId ||
        (typeof thread.source === "object" && thread.source !== null)) return false;
    return typeof thread.path === "string" && thread.path.length > 0 ? true : null;
  } catch (error) {
    // Codex reports unpersisted title-generation threads as not loaded after they finish.
    return error instanceof Error && /thread not (?:loaded|found)/i.test(error.message) ? false : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
