import type { TerminalQuickInputItem } from "@runweave/shared/terminal/input";

export type PersistedTerminalQuickInputRecord = TerminalQuickInputItem;

export interface TerminalQuickInputStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  list(): Promise<PersistedTerminalQuickInputRecord[]>;
  replaceAll(items: PersistedTerminalQuickInputRecord[]): Promise<void>;
}
