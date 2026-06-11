import { useMemo } from "react";
import type { TerminalPreviewFileDiffResponse } from "@browser-viewer/shared";

import { buildMobileDiff } from "../lib/mobile-diff";

function lineNumberLabel(oldLine: number | null, newLine: number | null): string {
  if (oldLine !== null && newLine !== null) {
    return `${oldLine}`;
  }
  if (oldLine !== null) {
    return `${oldLine}`;
  }
  if (newLine !== null) {
    return `${newLine}`;
  }
  return "";
}

export function MobileDiffView({
  diff,
}: {
  diff: TerminalPreviewFileDiffResponse;
}) {
  const lines = useMemo(
    () => buildMobileDiff(diff.oldContent, diff.newContent),
    [diff.newContent, diff.oldContent],
  );

  if (lines.length === 0) {
    return <p className="terminal-preview-empty">No textual changes.</p>;
  }

  return (
    <div className="mobile-diff" role="table" aria-label="File diff">
      {lines.map((line, index) => (
        <div
          className={`mobile-diff__line is-${line.kind}`}
          key={`${line.kind}-${index}-${line.oldLineNumber ?? "x"}-${
            line.newLineNumber ?? "x"
          }`}
          role="row"
        >
          <span className="mobile-diff__gutter" role="cell">
            {lineNumberLabel(line.oldLineNumber, line.newLineNumber)}
          </span>
          <span className="mobile-diff__marker" role="cell">
            {line.kind === "added"
              ? "+"
              : line.kind === "removed"
                ? "-"
                : line.kind === "collapsed"
                  ? "..."
                  : " "}
          </span>
          <code className="mobile-diff__content" role="cell">
            {line.content || " "}
          </code>
        </div>
      ))}
    </div>
  );
}
