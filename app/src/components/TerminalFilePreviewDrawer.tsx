import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { IonIcon } from "@ionic/react";
import { checkmarkOutline, copyOutline } from "ionicons/icons";
import type {
  TerminalPreviewChangeKind,
  TerminalPreviewFileResponse,
  TerminalPreviewGitStatus,
} from "@runweave/shared/terminal/preview";
import { resolveMarkdownPreviewHref } from "@runweave/shared/terminal-preview-core";

import { basenameOf, fileKindOf } from "../lib/terminal-file-format";
import { ApiError } from "../services/http";
import {
  getTerminalProjectPreviewAsset,
  getTerminalProjectPreviewFile,
} from "../services/terminal";
import type { SelectedTerminalChange } from "./TerminalChangesTab";
import { TerminalZoomableImage } from "./TerminalZoomableImage";
import { useCopyFeedback } from "../hooks/use-copy-feedback";
import { appQueryKeys } from "../features/query/app-query-provider";
import { useAppTerminalRuntime } from "../features/terminal/app-terminal-runtime";

export interface FileChangeInfo {
  kind: TerminalPreviewChangeKind;
  status: TerminalPreviewGitStatus;
}

function fileErrorMessage(status: number): string {
  if (status === 404) {
    return "File not found";
  }
  if (status === 413) {
    return "File is too large to preview";
  }
  if (status === 415) {
    return "Binary file cannot be previewed";
  }
  return "Unable to load file";
}

function resolveInlineHref(currentPath: string, href: string): string | null {
  const resolution = resolveMarkdownPreviewHref(currentPath, href);
  if (resolution.kind === "external") {
    return resolution.href;
  }
  if (resolution.kind === "same-document-hash") {
    return `#${encodeURIComponent(resolution.hash)}`;
  }
  return null;
}

function MarkdownPreview({ content, path }: { content: string; path: string }) {
  const allLines = content.split("\n");
  const frontmatterEnd =
    allLines[0]?.trim() === "---"
      ? allLines.findIndex((line, index) => index > 0 && line.trim() === "---")
      : -1;
  const lines =
    frontmatterEnd > 0 ? allLines.slice(frontmatterEnd + 1) : allLines;
  const elements: ReactNode[] = [];
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let listKind: "ol" | "ul" | null = null;
  let inCodeBlock = false;

  const renderInline = (value: string, keyPrefix: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenPattern.exec(value)) !== null) {
      if (match.index > cursor) {
        parts.push(value.slice(cursor, match.index));
      }

      const token = match[0];
      const key = `${keyPrefix}-${match.index}`;
      if (token.startsWith("**")) {
        parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("`")) {
        parts.push(<code key={key}>{token.slice(1, -1)}</code>);
      } else {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const label = linkMatch?.[1] ?? token;
        const rawHref = linkMatch?.[2];
        const href = rawHref ? resolveInlineHref(path, rawHref) : null;
        parts.push(
          href ? (
            <a href={href} key={key} rel="noreferrer" target="_blank">
              {label}
            </a>
          ) : (
            <span key={key}>{label}</span>
          ),
        );
      }

      cursor = match.index + token.length;
    }

    if (cursor < value.length) {
      parts.push(value.slice(cursor));
    }

    return parts.length > 0 ? parts : [value];
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    const items = listItems;
    const kind = listKind;
    listItems = [];
    listKind = null;
    const content = (
      <>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>
            {renderInline(item, `list-${elements.length}-${index}`)}
          </li>
        ))}
      </>
    );
    elements.push(
      kind === "ol" ? (
        <ol key={`list-${elements.length}`}>{content}</ol>
      ) : (
        <ul key={`list-${elements.length}`}>{content}</ul>
      ),
    );
  };

  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }
    const content = codeLines.join("\n");
    codeLines = [];
    elements.push(<pre key={`code-${elements.length}`}>{content}</pre>);
  };

  if (frontmatterEnd > 0) {
    elements.push(
      <pre className="terminal-markdown-frontmatter" key="frontmatter">
        {allLines.slice(0, frontmatterEnd + 1).join("\n")}
      </pre>,
    );
  }

  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      flushList();
      if (inCodeBlock) {
        inCodeBlock = false;
        flushCode();
      } else {
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed === "---") {
      flushList();
      elements.push(<hr key={`hr-${index}`} />);
      return;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      if (listKind === "ol") {
        flushList();
      }
      listKind = "ul";
      listItems.push(listMatch[1] ?? "");
      return;
    }

    const orderedListMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedListMatch) {
      if (listKind === "ul") {
        flushList();
      }
      listKind = "ol";
      listItems.push(orderedListMatch[1] ?? "");
      return;
    }

    flushList();
    if (trimmed.startsWith("### ")) {
      elements.push(
        <h3 key={index}>{renderInline(trimmed.slice(4), `h3-${index}`)}</h3>,
      );
    } else if (trimmed.startsWith("## ")) {
      elements.push(
        <h2 key={index}>{renderInline(trimmed.slice(3), `h2-${index}`)}</h2>,
      );
    } else if (trimmed.startsWith("# ")) {
      elements.push(
        <h1 key={index}>{renderInline(trimmed.slice(2), `h1-${index}`)}</h1>,
      );
    } else if (trimmed.startsWith("> ")) {
      elements.push(
        <blockquote key={index}>
          {renderInline(trimmed.slice(2), `quote-${index}`)}
        </blockquote>,
      );
    } else {
      elements.push(<p key={index}>{renderInline(trimmed, `p-${index}`)}</p>);
    }
  });

  flushList();
  flushCode();

  return <div className="terminal-markdown-preview">{elements}</div>;
}

export function TerminalFilePreviewDrawer({
  changeInfo,
  filePath,
  onClose,
  onShowChanges,
}: {
  changeInfo: FileChangeInfo | null;
  filePath: string;
  onClose: () => void;
  onShowChanges: (change: SelectedTerminalChange) => void;
}) {
  const { accessToken, apiBase, onAuthExpired, projectId, scope } =
    useAppTerminalRuntime();
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const image = fileKindOf(filePath, null) === "image";
  const fileQuery = useQuery({
    queryKey: projectId
      ? appQueryKeys.terminalFile(scope, projectId, filePath)
      : [...appQueryKeys.all(scope), "terminal-preview", "no-file"],
    queryFn: () =>
      getTerminalProjectPreviewFile(apiBase, accessToken, projectId!, filePath),
    enabled: Boolean(projectId) && !image,
  });
  const assetQuery = useQuery({
    queryKey: projectId
      ? appQueryKeys.terminalAsset(scope, projectId, filePath)
      : [...appQueryKeys.all(scope), "terminal-preview", "no-asset"],
    queryFn: () =>
      getTerminalProjectPreviewAsset(
        apiBase,
        accessToken,
        projectId!,
        filePath,
      ),
    enabled: Boolean(projectId) && image,
  });
  const file =
    (fileQuery.data as TerminalPreviewFileResponse | undefined) ?? null;
  const loading = image ? assetQuery.isFetching : fileQuery.isFetching;
  const requestError = image ? assetQuery.error : fileQuery.error;
  const error = requestError
    ? requestError instanceof ApiError
      ? fileErrorMessage(requestError.status)
      : requestError instanceof Error
        ? requestError.message
        : "Load failed"
    : null;
  const fileKind = fileKindOf(filePath, file?.language);
  const { copied: pathCopied, copyText: copyPath } = useCopyFeedback();

  useEffect(() => {
    if (!assetQuery.data) {
      setAssetUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(assetQuery.data);
    setAssetUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [assetQuery.data]);

  useEffect(() => {
    if (requestError instanceof ApiError && requestError.status === 401) {
      onAuthExpired();
    }
  }, [onAuthExpired, requestError]);

  return (
    <section
      aria-label="File preview"
      className="terminal-preview-pane terminal-file-preview-page"
    >
      <header className="terminal-file-preview-header">
        <button
          className="terminal-preview-link"
          onClick={onClose}
          type="button"
        >
          Back
        </button>
        <div>
          <h2>{basenameOf(filePath)}</h2>
          <p>{filePath}</p>
        </div>
        <div className="terminal-file-preview-actions">
          {changeInfo ? (
            <button
              className="terminal-preview-link"
              onClick={() =>
                onShowChanges({ path: filePath, kind: changeInfo.kind })
              }
              type="button"
            >
              Changes
            </button>
          ) : null}
          <button
            aria-label={pathCopied ? "Path copied" : "Copy path"}
            className={`terminal-preview-icon-button ${
              pathCopied ? "is-copied" : ""
            }`}
            onClick={() => void copyPath(filePath)}
            title={pathCopied ? "Path copied" : "Copy path"}
            type="button"
          >
            <IonIcon
              aria-hidden="true"
              icon={pathCopied ? checkmarkOutline : copyOutline}
            />
          </button>
        </div>
      </header>
      <div className="terminal-file-preview-body">
        {loading ? (
          <p className="terminal-preview-empty">Loading preview...</p>
        ) : error ? (
          <p className="terminal-preview-empty">{error}</p>
        ) : fileKind === "image" && assetUrl ? (
          <TerminalZoomableImage
            alt={basenameOf(filePath)}
            src={assetUrl}
            title={filePath}
          />
        ) : file && (fileKind === "markdown" || fileKind === "svg") ? (
          fileKind === "markdown" ? (
            <MarkdownPreview content={file.content} path={file.path} />
          ) : (
            <pre>{file.content}</pre>
          )
        ) : file ? (
          <pre>{file.content}</pre>
        ) : null}
      </div>
    </section>
  );
}
