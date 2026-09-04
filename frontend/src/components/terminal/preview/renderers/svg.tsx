import { useMemo } from "react";
import DOMPurify from "dompurify";

interface TerminalSvgPreviewProps {
  content: string;
}

export function TerminalSvgPreview({ content }: TerminalSvgPreviewProps) {
  const srcDoc = useMemo(() => {
    const sanitizedSvg = DOMPurify.sanitize(content, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "script"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "href", "xlink:href"],
    });
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        display: grid;
        place-items: center;
        background: #020617;
      }
      svg {
        max-width: 100%;
        max-height: 100%;
      }
    </style>
  </head>
  <body>${sanitizedSvg}</body>
</html>`;
  }, [content]);

  return (
    <iframe
      title="SVG preview"
      sandbox=""
      srcDoc={srcDoc}
      className="h-full w-full border-0 bg-slate-950"
    />
  );
}
