export type TerminalPreviewFileKind = "markdown" | "svg" | "image" | "text";

const IMAGE_PREVIEW_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
]);

function extensionOf(filePath: string): string {
  const basename = filePath.split("/").at(-1) ?? filePath;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

export function isSupportedTerminalImagePreviewPath(filePath: string): boolean {
  return IMAGE_PREVIEW_EXTENSIONS.has(extensionOf(filePath));
}

export function getTerminalPreviewFileKind(
  filePath: string,
  language: string | null | undefined,
): TerminalPreviewFileKind {
  const normalizedLanguage = language?.toLowerCase();
  const extension = extensionOf(filePath);
  if (normalizedLanguage === "markdown" || extension === ".md" || extension === ".mdx") {
    return "markdown";
  }
  if (normalizedLanguage === "svg" || extension === ".svg") {
    return "svg";
  }
  if (isSupportedTerminalImagePreviewPath(filePath)) {
    return "image";
  }
  return "text";
}

export function getTerminalPreviewMonacoLanguage(
  language: string | null | undefined,
): string {
  if (!language) {
    return "plaintext";
  }
  return language === "svg" ? "xml" : language;
}
