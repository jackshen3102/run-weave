import {
  getTerminalPreviewFileKind,
  terminalPreviewBasename,
  terminalPreviewDirname,
  terminalPreviewExtensionOf,
  terminalPreviewFormatBytes,
  terminalPreviewLanguageBadgeFor,
  terminalPreviewParentPath,
} from "@browser-viewer/shared";

export { type TerminalPreviewFileKind } from "@browser-viewer/shared";

export const extensionOf = terminalPreviewExtensionOf;
export const basenameOf = terminalPreviewBasename;
export const dirnameOf = terminalPreviewDirname;
export const fileKindOf = getTerminalPreviewFileKind;
export const languageBadgeFor = terminalPreviewLanguageBadgeFor;
export const formatBytes = terminalPreviewFormatBytes;
export const parentPathOf = terminalPreviewParentPath;
