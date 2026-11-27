import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { codexAppServerClient } from "../../voice/codex-app-server-client";
import type { TerminalPanelRecord, TerminalSessionRecord } from "../manager/records";
import { findQuestionExecutor } from "../questions/executor";

const exec = promisify(execFile);
const identities = new Map<string, Promise<boolean | null>>();

type ThreadMetadata = {
  id?: string;
  ephemeral?: boolean;
  parentThreadId?: string | null;
  source?: unknown;
  path?: string | null;
};

function evaluateThread(thread: ThreadMetadata | undefined, threadId: string): boolean | null {
  if (!thread || thread.id !== threadId) return null;
  if (
    thread.ephemeral === true ||
    thread.parentThreadId ||
    (typeof thread.source === "object" && thread.source !== null)
  ) {
    return false;
  }
  return typeof thread.path === "string" && thread.path.length > 0 ? true : null;
}

/** Only a persisted, non-child thread can own a legacy terminal's conversation. */
export function isCodexConversationThread(
  threadId: string,
  panel?: Pick<TerminalPanelRecord, "tmuxPaneId"> | null,
  session?: Pick<TerminalSessionRecord, "tmuxSocketPath"> | null,
): Promise<boolean | null> {
  const cached = identities.get(threadId);
  if (cached) return cached;
  const pending = resolveIdentity(threadId, panel, session).then((result) => {
    // Failures and absent sources may recover; do not retain negative lookups.
    if (result !== true && identities.get(threadId) === pending) identities.delete(threadId);
    return result;
  });
  identities.set(threadId, pending);
  if (identities.size > 256) identities.delete(identities.keys().next().value!);
  return pending;
}

async function resolveIdentity(
  threadId: string,
  panel?: Pick<TerminalPanelRecord, "tmuxPaneId"> | null,
  session?: Pick<TerminalSessionRecord, "tmuxSocketPath"> | null,
): Promise<boolean | null> {
  const local = await readIdentity(threadId);
  if (local === true || !panel?.tmuxPaneId || !session?.tmuxSocketPath) return local;
  const remote = await readRemoteExecutorIdentity(
    threadId,
    panel.tmuxPaneId,
    session.tmuxSocketPath,
  );
  return remote ?? local;
}

async function readIdentity(threadId: string): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      codexAppServerClient.sendRequest("thread/read", { threadId, includeTurns: false }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]) as { thread?: ThreadMetadata } | null;
    return evaluateThread(response?.thread, threadId);
  } catch (error) {
    // Codex reports unpersisted title-generation threads as not loaded after they finish.
    return error instanceof Error && /thread not (?:loaded|found)/i.test(error.message) ? false : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readRemoteExecutorIdentity(
  threadId: string,
  tmuxPaneId: string,
  tmuxSocketPath: string,
): Promise<boolean | null> {
  try {
    const { stdout } = await exec(
      "tmux",
      ["-S", tmuxSocketPath, "display-message", "-p", "-t", tmuxPaneId, "#{pane_pid}"],
      { timeout: 1500 },
    );
    const panePid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(panePid) || panePid <= 0) return null;
    const executor = await findQuestionExecutor(panePid);
    if (!executor) return null;
    return await querySocketThreadIdentity(executor.socket, threadId);
  } catch {
    return null;
  }
}

function querySocketThreadIdentity(socketPath: string, threadId: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 1500,
    });
    let settled = false;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1500);
    ws.on("error", () => finish(null));
    ws.on("close", () => finish(null));
    ws.once("open", () => {
      ws.send(JSON.stringify({
        id: "rw-id-init",
        method: "initialize",
        params: { clientInfo: { name: "runweave_thread_identity", version: "1" }, capabilities: { experimentalApi: true } },
      }));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: string; result?: { thread?: ThreadMetadata }; error?: { message?: string } };
        if (msg.id === "rw-id-init") {
          if (msg.error) { finish(null); return; }
          ws.send(JSON.stringify({ method: "initialized", params: {} }));
          ws.send(JSON.stringify({ id: "rw-id-read", method: "thread/read", params: { threadId, includeTurns: false } }));
        } else if (msg.id === "rw-id-read") {
          if (msg.error) {
            finish(/thread not (?:loaded|found)/i.test(msg.error.message ?? "") ? false : null);
            return;
          }
          finish(evaluateThread(msg.result?.thread, threadId));
        }
      } catch {
        finish(null);
      }
    });
  });
}
