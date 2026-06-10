import type { Terminal } from "@xterm/xterm";

export type TerminalRendererPreference = "dom" | "canvas" | "webgl" | "auto";

export interface TerminalRendererTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground?: string;
}

export interface TerminalRendererHandle {
  focus(): void;
  fit(): void;
  refresh(): void;
  resetAndWrite(data: string): void;
  write(data: string): void;
  clear(): void;
  getTerminal(): Terminal | null;
}

export interface TerminalRendererExtensionContext {
  terminal: Terminal;
  container: HTMLDivElement;
  fit: () => void;
  refresh: () => void;
}

export type TerminalRendererDisposable = { dispose(): void } | (() => void);

export interface TerminalRendererProps {
  active: boolean;
  className?: string;
  focusOnInteraction?: boolean;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  renderer?: TerminalRendererPreference;
  scrollbackLines?: number;
  theme?: TerminalRendererTheme;
  onBell?: () => void;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTerminalReady?: (
    context: TerminalRendererExtensionContext,
  ) => void | TerminalRendererDisposable | TerminalRendererDisposable[];
}
