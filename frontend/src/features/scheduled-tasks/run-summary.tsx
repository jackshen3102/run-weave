import { useMemo } from "react";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { safeArtifactUrl } from "./presentation";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.validateLink = (url) => Boolean(safeArtifactUrl(url));
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

export function RunSummary({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown.render(text), {
        ALLOWED_TAGS: [
          "p",
          "a",
          "em",
          "strong",
          "s",
          "code",
          "pre",
          "ul",
          "ol",
          "li",
          "blockquote",
          "br",
          "h1",
          "h2",
          "h3",
          "h4",
          "hr",
        ],
        ALLOWED_ATTR: ["href", "target", "rel"],
      }),
    [text],
  );
  return (
    <div
      className="mt-3 min-w-0 break-words text-sm [&_a]:break-all [&_a]:text-primary [&_a]:underline [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_li]:ml-4 [&_ul]:list-disc [&_ol]:list-decimal"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
