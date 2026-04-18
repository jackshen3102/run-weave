export type MarkdownPreviewHrefResolution =
  | { kind: "preview-file"; path: string; hash?: string }
  | { kind: "same-document-hash"; hash: string }
  | { kind: "external"; href: string }
  | { kind: "outside-project" }
  | { kind: "blocked" };

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function normalizePath(pathname: string): string | null {
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

function dirname(filePath: string): string {
  const segments = filePath.split("/");
  segments.pop();
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
      ? [dirname(currentPath), rawPath].filter(Boolean).join("/")
      : rawPath;
  const normalizedPath = normalizePath(basePath);
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
  if (!trimmedSrc || trimmedSrc.startsWith("#") || URL_SCHEME_PATTERN.test(trimmedSrc)) {
    return null;
  }

  const [rawSrcPath = ""] = trimmedSrc.split("#", 1);
  const rawPath = decodeURIComponent(rawSrcPath.replace(/^\/+/, ""));
  const basePath = trimmedSrc.startsWith("/")
    ? rawPath
    : [dirname(currentPath), rawPath].filter(Boolean).join("/");
  return normalizePath(basePath);
}
