export function normalizeRemoteCursor(cursor: string | undefined): string {
  if (!cursor || cursor === "auto") {
    return "default";
  }

  if (cursor.startsWith("url(")) {
    return "default";
  }

  return cursor;
}
