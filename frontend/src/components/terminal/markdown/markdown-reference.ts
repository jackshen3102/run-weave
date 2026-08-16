import type MarkdownIt from "markdown-it";

export const MARKDOWN_SOURCE_START_ATTRIBUTE = "data-source-start";
export const MARKDOWN_SOURCE_END_ATTRIBUTE = "data-source-end";

export interface MarkdownSourceSelection {
  startLine: number;
  endLine: number;
  selectedText: string;
  left: number;
  top: number;
}

export function addMarkdownSourceLineMetadata(markdown: MarkdownIt): void {
  markdown.core.ruler.push("runweave_source_lines", (state) => {
    for (const token of state.tokens) {
      if (!token.map || token.nesting === -1) {
        continue;
      }
      token.attrSet(MARKDOWN_SOURCE_START_ATTRIBUTE, String(token.map[0] + 1));
      token.attrSet(MARKDOWN_SOURCE_END_ATTRIBUTE, String(token.map[1]));
    }
  });
}

function closestSourceElement(
  container: HTMLElement,
  node: Node | null,
): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const sourceElement = element?.closest<HTMLElement>(
    `[${MARKDOWN_SOURCE_START_ATTRIBUTE}][${MARKDOWN_SOURCE_END_ATTRIBUTE}]`,
  );
  return sourceElement && container.contains(sourceElement)
    ? sourceElement
    : null;
}

function readSourceRange(
  element: HTMLElement,
): { startLine: number; endLine: number } | null {
  const startLine = Number(element.dataset.sourceStart);
  const endLine = Number(element.dataset.sourceEnd);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null;
  }
  return { startLine, endLine };
}

export function resolveMarkdownSourceSelection(
  container: HTMLElement,
  fallbackTarget?: Node | null,
): MarkdownSourceSelection | null {
  const selection = window.getSelection();
  const selectionRange =
    selection &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    container.contains(selection.anchorNode) &&
    container.contains(selection.focusNode)
      ? selection.getRangeAt(0)
      : null;
  const startElement = closestSourceElement(
    container,
    selectionRange?.startContainer ?? fallbackTarget ?? null,
  );
  const endElement = closestSourceElement(
    container,
    selectionRange?.endContainer ?? fallbackTarget ?? null,
  );
  if (!startElement || !endElement) {
    return null;
  }
  const startRange = readSourceRange(startElement);
  const endRange = readSourceRange(endElement);
  if (!startRange || !endRange) {
    return null;
  }

  const anchorRect =
    selectionRange?.getBoundingClientRect() ??
    startElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    startLine: Math.min(startRange.startLine, endRange.startLine),
    endLine: Math.max(startRange.endLine, endRange.endLine),
    selectedText: selectionRange ? (selection?.toString() ?? "") : "",
    left: Math.max(
      8,
      Math.min(
        container.clientWidth - 210,
        anchorRect.left - containerRect.left + container.scrollLeft,
      ),
    ),
    top: anchorRect.bottom - containerRect.top + container.scrollTop + 8,
  };
}

export function formatMarkdownLineReference(
  path: string,
  selection: Pick<MarkdownSourceSelection, "startLine" | "endLine">,
): string {
  return selection.startLine === selection.endLine
    ? `${path}:${selection.startLine}`
    : `${path}:${selection.startLine}-${selection.endLine}`;
}
