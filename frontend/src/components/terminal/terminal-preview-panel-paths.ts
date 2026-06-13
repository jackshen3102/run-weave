import type {
  TerminalPreviewFileDiffResponse,
  TerminalPreviewFileResponse,
  TerminalProjectListItem,
} from "@runweave/shared";
import type { TerminalPreviewMode } from "../../features/terminal/preview-store";

interface SelectedPreviewPathArgs {
  mode: TerminalPreviewMode | null;
  selectedFilePath?: string;
  selectedChangePath?: string;
  filePreview: TerminalPreviewFileResponse | null;
  fileDiff: TerminalPreviewFileDiffResponse | null;
}

interface PreviewCopyPathArgs {
  mode: TerminalPreviewMode | null;
  selectedPath: string | null;
  filePreview: TerminalPreviewFileResponse | null;
  fileDiff: TerminalPreviewFileDiffResponse | null;
  activeProject: TerminalProjectListItem | null;
}

export function getSelectedTerminalPreviewPath({
  mode,
  selectedFilePath,
  selectedChangePath,
  filePreview,
  fileDiff,
}: SelectedPreviewPathArgs): string | null {
  if (mode === "file" || mode === "explorer") {
    return selectedFilePath ?? filePreview?.path ?? null;
  }
  if (mode === "changes") {
    return selectedChangePath ?? fileDiff?.path ?? null;
  }
  return null;
}

export function getTerminalPreviewCopyPath({
  mode,
  selectedPath,
  filePreview,
  fileDiff,
  activeProject,
}: PreviewCopyPathArgs): string | null {
  if (!selectedPath) {
    return null;
  }
  if ((mode === "file" || mode === "explorer") && filePreview?.absolutePath) {
    return filePreview.absolutePath;
  }
  if (mode === "changes" && fileDiff?.absolutePath) {
    return fileDiff.absolutePath;
  }
  if (selectedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(selectedPath)) {
    return selectedPath;
  }
  if (!activeProject?.path) {
    return selectedPath;
  }
  const separator = activeProject.path.includes("\\") ? "\\" : "/";
  return `${activeProject.path.replace(/[\\/]+$/, "")}${separator}${selectedPath.replace(/^[\\/]+/, "")}`;
}
