import { randomBytes } from "node:crypto";

export const TERMINAL_INTERRUPT_ESCAPE_INPUT = "\x1b";

export function buildTerminalInputOperationId(): string {
  return `op_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
}
