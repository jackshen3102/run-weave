import { randomBytes } from "node:crypto";

const TERMINAL_SESSION_ID_BYTES = 4;
const MAX_TERMINAL_SESSION_ID_GENERATION_ATTEMPTS = 16;

function createTerminalSessionId(): string {
  return randomBytes(TERMINAL_SESSION_ID_BYTES).toString("hex");
}

export function createUniqueTerminalSessionId(
  hasSessionId: (candidate: string) => boolean,
): string {
  for (
    let attempt = 0;
    attempt < MAX_TERMINAL_SESSION_ID_GENERATION_ATTEMPTS;
    attempt += 1
  ) {
    const candidate = createTerminalSessionId();
    if (!hasSessionId(candidate)) {
      return candidate;
    }
  }

  throw new Error("Failed to generate a unique terminal session id");
}
