import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal-protocol";

export type AppTerminalDetailTab = "chat" | "changes" | "files";

export interface SelectedTerminalChange {
  path: string;
  kind: TerminalPreviewChangeKind;
}
