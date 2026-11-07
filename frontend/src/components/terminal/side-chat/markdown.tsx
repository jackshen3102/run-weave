import { useMemoizedFn } from "ahooks";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { memo, useMemo, useState, type MouseEvent } from "react";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.validateLink = (url) => /^https?:\/\//i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
const renderFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) =>
  `<div class="side-chat-code-block"><button type="button" data-copy-code>复制代码</button>${renderFence(tokens, index, options, env, renderer)}</div>`;

export const SideChatMarkdown = memo(function SideChatMarkdown({ text }: { text: string }) {
  const html = useMemo(() => ({ __html: DOMPurify.sanitize(markdown.render(text), {
    ALLOWED_TAGS: ["p", "br", "a", "em", "strong", "s", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "div", "button"],
    ALLOWED_ATTR: ["href", "target", "rel", "class", "type", "start", "align"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-copy-code"],
  }) }), [text]);
  const [feedback, setFeedback] = useState<{ text: string; message: string } | null>(null);
  const copyCode = useMemoizedFn(async (event: MouseEvent<HTMLDivElement>) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-copy-code]") : null;
    if (!button || !event.currentTarget.contains(button)) return;
    const code = button.parentElement?.querySelector("pre code")?.textContent;
    if (code === undefined || code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setFeedback({ text, message: "代码已复制" });
    } catch {
      setFeedback({ text, message: "复制失败，请选择代码后复制" });
    }
  });
  return <div className="min-w-0 text-sm leading-7 text-foreground">
    <div className="break-words [&_p+p]:mt-3 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline [&_hr]:my-4 [&_hr]:border-border [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_.side-chat-code-block]:my-3 [&_.side-chat-code-block]:min-w-0 [&_.side-chat-code-block]:overflow-hidden [&_.side-chat-code-block]:rounded-md [&_.side-chat-code-block]:border [&_.side-chat-code-block]:border-border [&_.side-chat-code-block>button]:block [&_.side-chat-code-block>button]:w-full [&_.side-chat-code-block>button]:bg-muted [&_.side-chat-code-block>button]:px-3 [&_.side-chat-code-block>button]:py-1 [&_.side-chat-code-block>button]:text-right [&_.side-chat-code-block>button]:text-xs [&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1"
      onClick={copyCode} dangerouslySetInnerHTML={html} />
    <span role="status" className="text-xs text-muted-foreground">{feedback?.text === text ? feedback.message : ""}</span>
  </div>;
});
