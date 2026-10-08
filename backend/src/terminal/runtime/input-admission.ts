import type { TerminalSessionRecord } from "../manager/records";
import { randomUUID } from "node:crypto";
import { logger } from "../../logging/index";
import type { TerminalInputIntent } from "./input-intent";

export class TerminalInputBusyError extends Error {
  constructor() {
    super(
      "Terminal input is in flight; wait for delivery before sending again",
    );
  }
}

interface InputAdmission {
  revision: object;
  pendingUserInput: Set<string | null>;
  inputVersion: string;
  edits: Map<string | null, object>;
  submissions: Map<string | null, object>;
  writers: number;
  returning: boolean;
}

// Session records have stable identity. Weak keys release state with the session.
// WS input targets the selected pane, so the safety boundary is the whole session.
const admissions = new WeakMap<TerminalSessionRecord, InputAdmission>();
const inputObservers = new WeakMap<TerminalSessionRecord, () => void>();

/** Ordinary input relinquishes an external supervisor's automatic write control. */
export function observeTerminalInput(session: TerminalSessionRecord, observer: () => void): () => void {
  inputObservers.set(session, observer);
  return () => { if (inputObservers.get(session) === observer) inputObservers.delete(session); };
}

export function terminalInputAdmission(
  session: TerminalSessionRecord,
): InputAdmission {
  let admission = admissions.get(session);
  if (!admission) {
    admission = { revision: {}, inputVersion: randomUUID(), pendingUserInput: new Set(), edits: new Map(), submissions: new Map(), writers: 0, returning: false };
    admissions.set(session, admission);
  }
  return admission;
}

/** Admit before I/O, not after an asynchronous Agent-state hook catches up. */
export function beginTerminalInput(session: TerminalSessionRecord, paneId: string | null = null, intent: TerminalInputIntent = { kind: "edit", source: "internal" }): () => void {
  const admission = terminalInputAdmission(session);
  if (admission.returning) throw new TerminalInputBusyError();
  recordInputIntent(session, paneId, intent);
  admission.writers += 1;
  return () => {
    admission.writers -= 1;
  };
}

/** A submit acknowledges only its own pane; other panes retain their drafts. */
export function acknowledgeTerminalPrompt(session: TerminalSessionRecord, paneId: string | null): void {
  const admission = terminalInputAdmission(session);
  const submitted = admission.submissions.get(paneId);
  admission.submissions.delete(paneId);
  // A delayed submit must never acknowledge edits made after that submit.
  if (submitted && submitted === admission.edits.get(paneId)) clearTerminalDraft(session, paneId, "prompt-submitted");
  else if (admission.pendingUserInput.has(paneId)) logger.info("terminal.input.draft-preserved", {
    terminalSessionId: session.id, paneId, reason: submitted ? "edit-after-submit" : "submit-not-correlated",
  });
}

function recordInputIntent(session: TerminalSessionRecord, paneId: string | null, intent: TerminalInputIntent) {
  if (intent.kind === "browse") return;
  const admission = terminalInputAdmission(session);
  inputObservers.get(session)?.();
  invalidateTerminalInput(session);
  if (intent.kind === "interrupt") return;
  const alreadyPending = admission.pendingUserInput.has(paneId);
  admission.pendingUserInput.add(paneId);
  admission.edits.set(paneId, admission.revision);
  if (intent.submit) admission.submissions.set(paneId, admission.revision);
  if (!alreadyPending || intent.submit) logger.info("terminal.input.draft-uncertain", {
    terminalSessionId: session.id, paneId, source: intent.source,
    inputVersion: admission.inputVersion, submit: intent.submit === true,
  });
}

/** Explicit user confirmation or a matching submit; never inferred from silence or Esc. */
export function clearTerminalDraft(session: TerminalSessionRecord, paneId: string | null, source: string): void {
  const admission = terminalInputAdmission(session);
  if (!admission.pendingUserInput.delete(paneId)) return;
  admission.edits.delete(paneId);
  admission.submissions.delete(paneId);
  logger.info("terminal.input.draft-cleared", { terminalSessionId: session.id, paneId, source, inputVersion: admission.inputVersion });
}

export function hasPendingTerminalInput(session: TerminalSessionRecord, paneId: string | null): boolean {
  const pending = terminalInputAdmission(session).pendingUserInput;
  return pending.has(null) || pending.has(paneId);
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
  const admission = terminalInputAdmission(session);
  admission.revision = {};
  admission.inputVersion = randomUUID();
}

const attachmentQueues = new WeakMap<
  TerminalSessionRecord,
  Array<() => Promise<void>>
>();

/** Capture the normal input's target before enqueueing this callback. */
export function queueBehindTextAttachment(
  session: TerminalSessionRecord,
  write: () => Promise<void>,
  paneId: string | null = null,
  intent: TerminalInputIntent = { kind: "edit", source: "queued-input" },
): Promise<void> | null {
  const queue = attachmentQueues.get(session);
  if (!queue) return null;
  // Accepted user input invalidates older saves even while delivery owns the PTY.
  recordInputIntent(session, paneId, intent);
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
  supervisor = false,
  paneId: string | null = null,
  submit = false,
): () => Promise<void> {
  const admission = terminalInputAdmission(session);
  if (
    admission.revision !== revision ||
    admission.returning ||
    admission.writers ||
    attachmentQueues.has(session)
  )
    throw new TerminalInputBusyError();
  if (!supervisor) {
    recordInputIntent(session, paneId, { kind: "edit", source: "text-attachment", submit });
  }
  admission.returning = true;
  invalidateTerminalInput(session);
  const queue: Array<() => Promise<void>> = [];
  attachmentQueues.set(session, queue);
  return async () => {
    // Keep queue registration until drained so subsequent keys cannot overtake.
    admission.returning = false;
    while (queue.length) await queue.shift()!();
    attachmentQueues.delete(session);
  };
}

/** Queue human keys during the short automatic write, while immediately revoking control. */
export function beginSupervisorDelivery(session: TerminalSessionRecord): () => Promise<void> {
  return beginTextAttachmentDelivery(session, terminalInputAdmission(session).revision, true);
}
