import type {
  IBufferRange,
  ILink,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import {
  findTerminalFileReferences,
  type TerminalFileLinkContext,
} from "@runweave/shared/terminal/file-link";

/** Uses buffer cells so wide/combining characters and soft wraps retain their coordinates. */
export function createTerminalFileLinkProvider(
  terminal: Terminal,
  activate: (
    event: MouseEvent,
    text: string,
    range: IBufferRange,
    context?: TerminalFileLinkContext,
  ) => void,
  getWorkspace: () => TerminalPanelWorkspace | null,
): ILinkProvider {
  const provider: ILinkProvider = {
    provideLinks(lineNumber, callback) {
      const buffer = terminal.buffer.active;
      let first = lineNumber - 1;
      let last = first;
      // Bound work for pathological output; never join hard line breaks.
      while (
        first > 0 &&
        buffer.getLine(first)?.isWrapped &&
        lineNumber - first < 32
      )
        first--;
      while (
        last + 1 < buffer.length &&
        buffer.getLine(last + 1)?.isWrapped &&
        last - first < 32
      )
        last++;
      const panels = getWorkspace()?.panels ?? [];
      const split = panels.length > 1;
      if (split) {
        first = lineNumber - 1;
        last = first;
      }
      const row = lineNumber - 1 - buffer.viewportY;
      const regions = split
        ? panels.flatMap(({ geometry: g }) =>
            g && row >= g.paneTop && row < g.paneTop + g.paneHeight
              ? [{ left: g.paneLeft, right: g.paneLeft + g.paneWidth }]
              : [],
          )
        : [{ left: 0, right: terminal.cols }];
      const links: ILink[] = [];
      for (const region of regions) {
        let text = "";
        const starts: Array<{ x: number; y: number }> = [];
        const ends: Array<{ x: number; y: number }> = [];
        for (let y = first; y <= last; y++) {
          const line = buffer.getLine(y);
          if (!line) continue;
          for (
            let x = region.left;
            x < Math.min(line.length, region.right);
            x++
          ) {
            const cell = line.getCell(x);
            if (!cell || cell.getWidth() === 0) continue;
            // xterm leaves a blank final cell when a wide character wraps early.
            // That cell is padding, not a space in the filename.
            if (
              !split &&
              y < last &&
              x === line.length - 1 &&
              !cell.getChars() &&
              buffer
                .getLine(y + 1)
                ?.getCell(0)
                ?.getWidth() === 2
            )
              continue;
            const chars = cell.getChars() || " ";
            for (let index = 0; index < chars.length; index++) {
              starts.push({ x: x + 1, y: y + 1 });
              ends.push({ x: x + cell.getWidth(), y: y + 1 });
            }
            text += chars;
          }
        }
        for (const match of findTerminalFileReferences(text)) {
          const start = starts[match.start];
          const end = ends[match.end - 1];
          if (!start || !end || start.y > lineNumber || end.y < lineNumber)
            continue;
          const range = { start, end };
          links.push({
            text: match.text,
            range,
            activate: (event, value) => {
              if (terminal.hasSelection()) return;
              // Hover may precede a redraw. Recheck the hit before capturing context.
              provider.provideLinks(range.end.y, (currentLinks) => {
                if (
                  !currentLinks?.some(
                    (link) =>
                      link.text === value &&
                      link.range.start.x === start.x &&
                      link.range.start.y === start.y &&
                      link.range.end.x === end.x &&
                      link.range.end.y === end.y,
                  )
                )
                  return;
                const context = /^["'`]|^file:\/\//i.test(value)
                  ? undefined
                  : captureFileLinkContext(terminal, range, getWorkspace());
                activate(event, value, range, context);
              });
            },
          });
        }
      }
      callback(links);
    },
  };
  return provider;
}

function captureFileLinkContext(
  terminal: Terminal,
  range: IBufferRange,
  workspace: TerminalPanelWorkspace | null,
): TerminalFileLinkContext | undefined {
  const buffer = terminal.buffer.active;
  const row = range.start.y - 1;
  const panels = workspace?.panels ?? [];
  const pane =
    panels.length > 1
      ? panels.find(
          ({ geometry: g }) =>
            g &&
            row - buffer.viewportY >= g.paneTop &&
            row - buffer.viewportY < g.paneTop + g.paneHeight &&
            range.start.x - 1 >= g.paneLeft &&
            range.start.x - 1 < g.paneLeft + g.paneWidth,
        )?.geometry
      : null;
  if (panels.length > 1 && !pane) return undefined;
  const left = pane?.paneLeft ?? 0;
  const right = pane ? left + pane.paneWidth : terminal.cols;
  const minimumRow = pane ? buffer.viewportY + pane.paneTop : 0;
  const linePrefix =
    buffer.getLine(row)?.translateToString(false, left, range.start.x - 1) ??
    "";
  if (linePrefix.trim()) return undefined;
  const precedingLines: string[] = [];
  for (let y = Math.max(minimumRow, row - 4); y < row; y++) {
    precedingLines.push(
      buffer.getLine(y)?.translateToString(true, left, right) ?? "",
    );
  }
  return { linePrefix, precedingLines };
}
