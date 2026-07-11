import { getTerminalPreviewFileKind, terminalPreviewBasename, terminalPreviewDirname, terminalPreviewExtensionOf, terminalPreviewFormatBytes, terminalPreviewLanguageBadgeFor, terminalPreviewParentPath } from "@runweave/shared/terminal-preview-core";

export { type TerminalPreviewFileKind } from "@runweave/shared/terminal-preview-core";

export const extensionOf = terminalPreviewExtensionOf;
export const basenameOf = terminalPreviewBasename;
export const dirnameOf = terminalPreviewDirname;
export const fileKindOf = getTerminalPreviewFileKind;
export const languageBadgeFor = terminalPreviewLanguageBadgeFor;
export const formatBytes = terminalPreviewFormatBytes;
export const parentPathOf = terminalPreviewParentPath;
