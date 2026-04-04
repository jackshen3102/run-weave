interface RecentTerminalSelection {
  projectId: string;
  terminalSessionId: string | null;
  projectSessionIds: Record<string, string>;
}

interface SaveRecentTerminalSelectionInput {
  projectId: string;
  terminalSessionId: string | null;
}

function buildStorageKey(apiBase: string): string {
  return `viewer.terminal.recent.${apiBase}`;
}

export function loadRecentTerminalSelection(
  apiBase: string,
): RecentTerminalSelection | null {
  const raw = localStorage.getItem(buildStorageKey(apiBase));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RecentTerminalSelection>;
    if (typeof parsed.projectId !== "string") {
      return null;
    }

    const projectSessionIds =
      parsed.projectSessionIds &&
      typeof parsed.projectSessionIds === "object" &&
      !Array.isArray(parsed.projectSessionIds)
        ? Object.fromEntries(
            Object.entries(parsed.projectSessionIds).filter(
              (entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
          )
        : {};

    if (typeof parsed.terminalSessionId === "string") {
      return {
        projectId: parsed.projectId,
        terminalSessionId: parsed.terminalSessionId,
        projectSessionIds: {
          ...projectSessionIds,
          [parsed.projectId]: parsed.terminalSessionId,
        },
      };
    }

    if (parsed.terminalSessionId !== null) {
      return null;
    }

    return {
      projectId: parsed.projectId,
      terminalSessionId: null,
      projectSessionIds,
    };
  } catch {
    return null;
  }
}

export function saveRecentTerminalSelection(
  apiBase: string,
  selection: SaveRecentTerminalSelectionInput,
): void {
  const currentSelection = loadRecentTerminalSelection(apiBase);
  const nextProjectSessionIds = { ...(currentSelection?.projectSessionIds ?? {}) };
  if (selection.terminalSessionId) {
    nextProjectSessionIds[selection.projectId] = selection.terminalSessionId;
  }

  localStorage.setItem(
    buildStorageKey(apiBase),
    JSON.stringify({
      projectId: selection.projectId,
      terminalSessionId: selection.terminalSessionId,
      projectSessionIds: nextProjectSessionIds,
    } satisfies RecentTerminalSelection),
  );
}
