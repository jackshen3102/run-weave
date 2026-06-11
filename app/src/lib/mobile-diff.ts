export type MobileDiffLineKind = "equal" | "added" | "removed" | "collapsed";

export interface MobileDiffLine {
  kind: MobileDiffLineKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

const MAX_LCS_LINES = 800;
const MAX_LCS_COST = 180_000;
const UNCHANGED_CONTEXT_LINES = 3;

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.replace(/\n$/, "").split("\n");
}

function buildFallbackDiff(oldLines: string[], newLines: string[]): MobileDiffLine[] {
  return [
    ...oldLines.map((content, index) => ({
      kind: "removed" as const,
      oldLineNumber: index + 1,
      newLineNumber: null,
      content,
    })),
    ...newLines.map((content, index) => ({
      kind: "added" as const,
      oldLineNumber: null,
      newLineNumber: index + 1,
      content,
    })),
  ];
}

function collapseEqualLines(lines: MobileDiffLine[]): MobileDiffLine[] {
  const collapsed: MobileDiffLine[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind !== "equal") {
      collapsed.push(line);
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length && lines[index]?.kind === "equal") {
      index += 1;
    }

    const group = lines.slice(start, index);
    if (group.length <= UNCHANGED_CONTEXT_LINES * 2) {
      collapsed.push(...group);
      continue;
    }

    collapsed.push(...group.slice(0, UNCHANGED_CONTEXT_LINES));
    collapsed.push({
      kind: "collapsed",
      oldLineNumber: null,
      newLineNumber: null,
      content: `${group.length - UNCHANGED_CONTEXT_LINES * 2} unchanged lines`,
    });
    collapsed.push(...group.slice(-UNCHANGED_CONTEXT_LINES));
  }

  return collapsed;
}

export function buildMobileDiff(
  oldContent: string,
  newContent: string,
): MobileDiffLine[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  if (
    oldLines.length + newLines.length > MAX_LCS_LINES ||
    oldLines.length * newLines.length > MAX_LCS_COST
  ) {
    return buildFallbackDiff(oldLines, newLines);
  }

  const width = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * width);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[offset] = table[(oldIndex + 1) * width + newIndex + 1] + 1;
      } else {
        table[offset] = Math.max(
          table[(oldIndex + 1) * width + newIndex],
          table[oldIndex * width + newIndex + 1],
        );
      }
    }
  }

  const lines: MobileDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({
        kind: "equal",
        oldLineNumber: oldIndex + 1,
        newLineNumber: newIndex + 1,
        content: oldLines[oldIndex] ?? "",
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      table[(oldIndex + 1) * width + newIndex] >=
      table[oldIndex * width + newIndex + 1]
    ) {
      lines.push({
        kind: "removed",
        oldLineNumber: oldIndex + 1,
        newLineNumber: null,
        content: oldLines[oldIndex] ?? "",
      });
      oldIndex += 1;
    } else {
      lines.push({
        kind: "added",
        oldLineNumber: null,
        newLineNumber: newIndex + 1,
        content: newLines[newIndex] ?? "",
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    lines.push({
      kind: "removed",
      oldLineNumber: oldIndex + 1,
      newLineNumber: null,
      content: oldLines[oldIndex] ?? "",
    });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    lines.push({
      kind: "added",
      oldLineNumber: null,
      newLineNumber: newIndex + 1,
      content: newLines[newIndex] ?? "",
    });
    newIndex += 1;
  }

  return collapseEqualLines(lines);
}
