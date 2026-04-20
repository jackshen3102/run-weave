import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import mermaid from "mermaid";
import {
  resolveMarkdownPreviewAssetPath,
  resolveMarkdownPreviewHref,
} from "../../features/terminal/markdown-preview";
import { HttpError } from "../../services/http";
import { getTerminalProjectPreviewAsset } from "../../services/terminal";

interface TerminalMarkdownPreviewProps {
  apiBase: string;
  token: string;
  projectId: string;
  content: string;
  path: string;
  scrollRatio?: number;
  onScrollRatioChange?: (ratio: number) => void;
  onAuthExpired?: () => void;
  onOpenFile: (path: string, hash?: string) => void;
}

interface MarkdownRenderResult {
  html: string;
  mermaidBlocks: string[];
}

interface ZoomedMarkdownImage {
  src: string;
  alt: string;
  assetPath?: string;
}

let markdown: MarkdownIt | null = null;
let mermaidInitialized = false;

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getMarkdownRenderer(): MarkdownIt {
  if (markdown) {
    return markdown;
  }

  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  })
    .use(anchor, {
      permalink: anchor.permalink.linkInsideHeader({
        symbol: "#",
        placement: "after",
        class: "ml-2 text-slate-500 no-underline opacity-0 group-hover:opacity-100",
      }),
    })
    .use(taskLists, { enabled: false })
    .use(footnote);

  const defaultFence =
    renderer.renderer.rules.fence?.bind(renderer.renderer) ??
    ((tokens, index, options, env, self) =>
      self.renderToken(tokens, index, options));

  renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const info = token?.info.trim().split(/\s+/)[0]?.toLowerCase();
    if (info !== "mermaid" || !token) {
      return defaultFence(tokens, index, options, env, self);
    }
    const renderEnv = env as { mermaidBlocks?: string[] };
    renderEnv.mermaidBlocks ??= [];
    const blockIndex = renderEnv.mermaidBlocks.push(token.content) - 1;
    return `<div class="terminal-markdown-mermaid" data-mermaid-index="${blockIndex}"><pre>${renderer.utils.escapeHtml(token.content)}</pre></div>`;
  };

  const defaultImage =
    renderer.renderer.rules.image?.bind(renderer.renderer) ??
    ((tokens, index, options, env, self) =>
      self.renderToken(tokens, index, options));

  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const src = token?.attrGet("src") ?? "";
    const renderEnv = env as { currentPath?: string };
    const assetPath = renderEnv.currentPath
      ? resolveMarkdownPreviewAssetPath(renderEnv.currentPath, src)
      : null;
    if (!token || !assetPath) {
      return defaultImage(tokens, index, options, env, self);
    }
    const alt = token.content || token.attrGet("alt") || assetPath;
    return `<span class="terminal-markdown-local-image" data-preview-src="${renderer.utils.escapeHtml(
      src,
    )}" data-preview-asset-path="${renderer.utils.escapeHtml(
      assetPath,
    )}" data-preview-alt="${renderer.utils.escapeHtml(alt)}">Loading image...</span>`;
  };

  renderer.validateLink = (url) => {
    const normalized = url.trim().toLowerCase();
    return !(
      normalized.startsWith("javascript:") ||
      normalized.startsWith("vbscript:") ||
      normalized.startsWith("data:")
    );
  };

  markdown = renderer;
  return renderer;
}

function initializeMermaid(): void {
  if (mermaidInitialized) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
  });
  mermaidInitialized = true;
}

function renderMarkdown(content: string, currentPath: string): MarkdownRenderResult {
  const env: { currentPath: string; mermaidBlocks: string[] } = {
    currentPath,
    mermaidBlocks: [],
  };
  const rawHtml = getMarkdownRenderer().render(content, env);
  return {
    html: DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: [
        "target",
        "rel",
        "data-mermaid-index",
        "data-preview-src",
        "data-preview-asset-path",
        "data-preview-alt",
      ],
    }),
    mermaidBlocks: env.mermaidBlocks,
  };
}

function TerminalMarkdownImageLightbox({
  image,
  onClose,
}: {
  image: ZoomedMarkdownImage | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!image) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label="Image preview"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-100 hover:border-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400"
        onClick={onClose}
      >
        Close
      </button>
      {image.assetPath ? (
        <div className="absolute bottom-4 left-4 right-4 truncate text-center text-xs text-slate-300">
          {image.assetPath}
        </div>
      ) : null}
      <img
        src={image.src}
        alt={image.alt}
        className="max-h-[90vh] max-w-[90vw] rounded-md object-contain"
        onClick={(event) => {
          event.stopPropagation();
        }}
      />
    </div>
  );
}

export function TerminalMarkdownPreview({
  apiBase,
  token,
  projectId,
  content,
  path,
  scrollRatio,
  onScrollRatioChange,
  onAuthExpired,
  onOpenFile,
}: TerminalMarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [zoomedImage, setZoomedImage] = useState<ZoomedMarkdownImage | null>(null);
  const rendered = useMemo(() => renderMarkdown(content, path), [content, path]);
  const renderedHtml = useMemo(() => ({ __html: rendered.html }), [rendered.html]);
  const closeZoomedImage = useCallback(() => {
    setZoomedImage(null);
  }, []);

  useEffect(() => {
    setZoomedImage(null);
  }, [content, path]);

  useEffect(() => {
    if (scrollRatio === undefined) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = maxScrollTop * Math.min(Math.max(scrollRatio, 0), 1);
  }, [scrollRatio]);

  useEffect(() => {
    let cancelled = false;
    initializeMermaid();
    const renderDiagrams = async (): Promise<void> => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const targets = Array.from(
        container.querySelectorAll<HTMLElement>(".terminal-markdown-mermaid"),
      );
      await Promise.all(
        targets.map(async (target) => {
          const index = Number(target.dataset.mermaidIndex);
          const source = rendered.mermaidBlocks[index];
          if (!source) {
            return;
          }
          try {
            const id = `terminal-mermaid-${hashString(`${path}:${index}:${source}`)}`;
            const result = await mermaid.render(id, source);
            if (!cancelled) {
              target.innerHTML = DOMPurify.sanitize(result.svg);
            }
          } catch (error) {
            if (!cancelled) {
              target.innerHTML = `<pre>${DOMPurify.sanitize(
                error instanceof Error ? error.message : String(error),
              )}</pre>`;
              target.classList.add("text-rose-300");
            }
          }
        }),
      );
    };
    void renderDiagrams();
    return () => {
      cancelled = true;
    };
  }, [path, rendered]);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    const loadLocalImages = async (): Promise<void> => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const placeholders = Array.from(
        container.querySelectorAll<HTMLElement>(".terminal-markdown-local-image"),
      );
      await Promise.all(
        placeholders.map(async (placeholder) => {
          const assetPath = placeholder.dataset.previewAssetPath;
          if (!assetPath) {
            return;
          }
          try {
            const blob = await getTerminalProjectPreviewAsset(
              apiBase,
              token,
              projectId,
              assetPath,
            );
            if (cancelled) {
              return;
            }
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.push(objectUrl);
            const image = document.createElement("img");
            image.alt = placeholder.dataset.previewAlt ?? assetPath;
            image.dataset.previewAssetPath = assetPath;
            image.src = objectUrl;
            placeholder.replaceWith(image);
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (error instanceof HttpError && error.status === 401) {
              onAuthExpired?.();
            }
            placeholder.replaceWith(
              Object.assign(document.createElement("span"), {
                className: "text-rose-300",
                textContent:
                  error instanceof Error ? error.message : "Image cannot be previewed",
              }),
            );
          }
        }),
      );
    };
    void loadLocalImages();
    return () => {
      cancelled = true;
      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [apiBase, onAuthExpired, path, projectId, rendered, token]);

  return (
    <div
      ref={containerRef}
      className="terminal-markdown-preview h-full overflow-auto px-5 py-4 text-sm leading-6 text-slate-200"
      onScroll={(event) => {
        if (!onScrollRatioChange) {
          return;
        }
        const element = event.currentTarget;
        const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        onScrollRatioChange(maxScrollTop > 0 ? element.scrollTop / maxScrollTop : 0);
      }}
      onClick={(event) => {
        if (!(event.target instanceof Element)) {
          return;
        }
        const target = event.target;
        const anchorElement = target.closest("a[href]");
        if (anchorElement instanceof HTMLAnchorElement) {
          const href = anchorElement.getAttribute("href") ?? "";
          const resolved = resolveMarkdownPreviewHref(path, href);
          if (resolved.kind === "preview-file") {
            event.preventDefault();
            setLinkError(null);
            onOpenFile(resolved.path, resolved.hash);
          } else if (resolved.kind === "same-document-hash") {
            event.preventDefault();
            document.getElementById(resolved.hash)?.scrollIntoView({ block: "start" });
          } else if (resolved.kind === "external") {
            event.preventDefault();
            window.open(resolved.href, "_blank", "noreferrer");
          } else if (resolved.kind === "outside-project") {
            event.preventDefault();
            setLinkError("Path is outside the project path");
          } else {
            event.preventDefault();
            setLinkError("Link is not supported");
          }
          return;
        }

        const imageElement = target.closest("img");
        if (imageElement instanceof HTMLImageElement) {
          event.preventDefault();
          setZoomedImage({
            src: imageElement.currentSrc || imageElement.src,
            alt:
              imageElement.alt ||
              imageElement.dataset.previewAssetPath ||
              "Preview image",
            assetPath: imageElement.dataset.previewAssetPath,
          });
        }
      }}
    >
      {linkError ? (
        <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          {linkError}
        </div>
      ) : null}
      <div
        className="max-w-none [&_a]:text-cyan-300 [&_a]:underline [&_blockquote]:border-l [&_blockquote]:border-slate-700 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-slate-900 [&_code]:px-1 [&_h1]:group [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:group [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:group [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:border-slate-800 [&_img]:my-4 [&_img]:max-w-full [&_img]:cursor-zoom-in [&_img]:rounded-lg [&_img]:border [&_img]:border-slate-800 [&_li]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-slate-900 [&_pre]:p-3 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-800 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-slate-800 [&_th]:px-2 [&_th]:py-1 [&_ul]:ml-5 [&_ul]:list-disc"
        dangerouslySetInnerHTML={renderedHtml}
      />
      <TerminalMarkdownImageLightbox
        image={zoomedImage}
        onClose={closeZoomedImage}
      />
    </div>
  );
}
