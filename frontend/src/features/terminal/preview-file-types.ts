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

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "svg",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".toml": "ini",
  ".dockerfile": "dockerfile",
  ".lua": "lua",
  ".php": "php",
  ".r": "r",
  ".vue": "html",
};

export function extensionToLanguageHint(
  filePath: string,
): string | null {
  const basename = (filePath.split("/").at(-1) ?? filePath).toLowerCase();
  if (basename === "dockerfile") {
    return "dockerfile";
  }
  const ext = extensionOf(filePath);
  if (!ext) {
    return null;
  }
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}
