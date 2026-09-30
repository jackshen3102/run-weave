import type { TerminalSessionRecord } from "../manager/records";

export class TerminalInputBusyError extends Error {
  constructor() {
    super(
      "Terminal input is in flight; wait for delivery before sending again",
    );
  }
}

interface InputAdmission {
  revision: object;
  writers: number;
  returning: boolean;
}

// Session records have stable identity. Weak keys release state with the session.
// WS input targets the selected pane, so the safety boundary is the whole session.
const admissions = new WeakMap<TerminalSessionRecord, InputAdmission>();

export function terminalInputAdmission(
  session: TerminalSessionRecord,
): InputAdmission {
  let admission = admissions.get(session);
  if (!admission) {
    admission = { revision: {}, writers: 0, returning: false };
    admissions.set(session, admission);
  }
  return admission;
}

/** Admit before I/O, not after an asynchronous Agent-state hook catches up. */
export function beginTerminalInput(session: TerminalSessionRecord): () => void {
  const admission = terminalInputAdmission(session);
  if (admission.returning) throw new TerminalInputBusyError();
  admission.revision = {};
  admission.writers += 1;
  return () => {
    admission.writers -= 1;
  };
}

/** Only the short handoff delivery is exclusive, never the user's assistance. */
export function beginTerminalReturn(
  session: TerminalSessionRecord,
): () => void {
  const admission = terminalInputAdmission(session);
  if (admission.returning || admission.writers || attachmentQueues.has(session))
    throw new TerminalInputBusyError();
  admission.returning = true;
  return () => {
    admission.returning = false;
  };
}

export function invalidateTerminalInput(session: TerminalSessionRecord): void {
  terminalInputAdmission(session).revision = {};
}

const attachmentQueues = new WeakMap<
  TerminalSessionRecord,
  Array<() => Promise<void>>
>();

/** Capture the normal input's target before enqueueing this callback. */
export function queueBehindTextAttachment(
  session: TerminalSessionRecord,
  write: () => Promise<void>,
): Promise<void> | null {
  const queue = attachmentQueues.get(session);
  if (!queue) return null;
  // Accepted user input invalidates older saves even while delivery owns the PTY.
  invalidateTerminalInput(session);
  return new Promise<void>((resolve, reject) => {
    queue.push(async () => {
      try {
        await write();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Synchronous check + acquisition: disk persistence never holds this lease. */
export function beginTextAttachmentDelivery(
  session: TerminalSessionRecord,
  revision: object,
): () => Promise<void> {
  const admission = terminalInputAdmission(session);
  if (
    admission.revision !== revision ||
    admission.returning ||
    admission.writers ||
    attachmentQueues.has(session)
  )
    throw new TerminalInputBusyError();
  admission.returning = true;
  admission.revision = {};
  const queue: Array<() => Promise<void>> = [];
  attachmentQueues.set(session, queue);
  return async () => {
    // Keep queue registration until drained so subsequent keys cannot overtake.
    admission.returning = false;
    while (queue.length) await queue.shift()!();
    attachmentQueues.delete(session);
  };
}
