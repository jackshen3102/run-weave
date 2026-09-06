import type { TerminalSessionRecord } from "../manager/manager";

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
  if (admission.returning || admission.writers)
    throw new TerminalInputBusyError();
  admission.returning = true;
  return () => {
    admission.returning = false;
  };
}
