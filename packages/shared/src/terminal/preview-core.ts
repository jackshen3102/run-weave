export type TerminalPreviewFileKind = "markdown" | "svg" | "image" | "text";

export type MarkdownPreviewHrefResolution =
  | { kind: "preview-file"; path: string; hash?: string }
  | { kind: "same-document-hash"; hash: string }
  | { kind: "external"; href: string }
  | { kind: "outside-project" }
  | { kind: "blocked" };

export interface TerminalPreviewRequestSequencer {
  current(): number;
  invalidate(): void;
  isCurrent(requestId: number): boolean;
  next(): number;
}

const IMAGE_PREVIEW_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
]);

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

const SHORT_LANGUAGE_BADGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TS",
  ".tsx": "TSX",
  ".js": "JS",
  ".jsx": "JSX",
  ".json": "JSON",
  ".md": "MD",
  ".mdx": "MDX",
  ".css": "CSS",
  ".html": "HTML",
  ".svg": "SVG",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".py": "PY",
  ".go": "GO",
  ".rs": "RS",
  ".sh": "SH",
};

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export function terminalPreviewBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

export function terminalPreviewDirname(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function terminalPreviewParentPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function terminalPreviewExtensionOf(filePath: string): string {
  const basename = terminalPreviewBasename(filePath);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

export function isSupportedTerminalImagePreviewPath(filePath: string): boolean {
  return IMAGE_PREVIEW_EXTENSIONS.has(terminalPreviewExtensionOf(filePath));
}

export function getTerminalPreviewFileKind(
  filePath: string,
  language: string | null | undefined,
): TerminalPreviewFileKind {
  const normalizedLanguage = language?.toLowerCase();
  const extension = terminalPreviewExtensionOf(filePath);
  if (
    normalizedLanguage === "markdown" ||
    extension === ".md" ||
    extension === ".mdx"
  ) {
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

export function extensionToLanguageHint(filePath: string): string | null {
  const basename = terminalPreviewBasename(filePath).toLowerCase();
  if (basename === "dockerfile") {
    return "dockerfile";
  }
  const extension = terminalPreviewExtensionOf(filePath);
  if (!extension) {
    return null;
  }
  return EXTENSION_LANGUAGE_MAP[extension] ?? null;
}

export function terminalPreviewLanguageBadgeFor(filePath: string): string {
  return SHORT_LANGUAGE_BADGE_BY_EXTENSION[terminalPreviewExtensionOf(filePath)] ?? "FILE";
}

export function terminalPreviewFormatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 102.4) / 10} KB`;
  }
  return `${Math.round(value / 1024 / 102.4) / 10} MB`;
}

function normalizePreviewPath(pathname: string): string | null {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function resolveMarkdownPreviewHref(
  currentPath: string,
  href: string,
): MarkdownPreviewHrefResolution {
  const trimmedHref = href.trim();
  if (!trimmedHref) {
    return { kind: "blocked" };
  }
  if (trimmedHref.startsWith("#")) {
    return {
      kind: "same-document-hash",
      hash: decodeURIComponent(trimmedHref.slice(1)),
    };
  }

  if (URL_SCHEME_PATTERN.test(trimmedHref)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmedHref);
    } catch {
      return { kind: "blocked" };
    }
    return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)
      ? { kind: "external", href: trimmedHref }
      : { kind: "blocked" };
  }

  const [rawHrefPath = "", rawHash] = trimmedHref.split("#", 2);
  const rawPath = decodeURIComponent(rawHrefPath.replace(/^\/+/, ""));
  const hash = rawHash ? decodeURIComponent(rawHash) : undefined;
  const basePath =
    trimmedHref.startsWith("./") || trimmedHref.startsWith("../")
      ? [terminalPreviewDirname(currentPath), rawPath].filter(Boolean).join("/")
      : rawPath;
  const normalizedPath = normalizePreviewPath(basePath);
  if (!normalizedPath) {
    return { kind: "outside-project" };
  }
  return hash
    ? { kind: "preview-file", path: normalizedPath, hash }
    : { kind: "preview-file", path: normalizedPath };
}

export function resolveMarkdownPreviewAssetPath(
  currentPath: string,
  src: string,
): string | null {
  const trimmedSrc = src.trim();
  if (
    !trimmedSrc ||
    trimmedSrc.startsWith("#") ||
    URL_SCHEME_PATTERN.test(trimmedSrc)
  ) {
    return null;
  }

  const [rawSrcPath = ""] = trimmedSrc.split("#", 1);
  const rawPath = decodeURIComponent(rawSrcPath.replace(/^\/+/, ""));
  const basePath = trimmedSrc.startsWith("/")
    ? rawPath
    : [terminalPreviewDirname(currentPath), rawPath].filter(Boolean).join("/");
  return normalizePreviewPath(basePath);
}

export function isSafeTerminalMarkdownHref(href: string): boolean {
  const resolution = resolveMarkdownPreviewHref("", href);
  return resolution.kind !== "blocked" && resolution.kind !== "outside-project";
}

export function createTerminalPreviewRequestSequencer(): TerminalPreviewRequestSequencer {
  let latestRequestId = 0;
  return {
    current() {
      return latestRequestId;
    },
    invalidate() {
      latestRequestId += 1;
    },
    isCurrent(requestId: number) {
      return requestId === latestRequestId;
    },
    next() {
      latestRequestId += 1;
      return latestRequestId;
    },
  };
}
