export const MAX_CACHED_TERMINAL_SURFACES = 5;

interface ResolveCachedTerminalSurfaceIdsParams {
  activeSessionId: string | null;
  cachedSessionIds: string[];
  sessionIds: string[];
  maxCachedSurfaces?: number;
}

export function resolveCachedTerminalSurfaceIds({
  activeSessionId,
  cachedSessionIds,
  sessionIds,
  maxCachedSurfaces = MAX_CACHED_TERMINAL_SURFACES,
}: ResolveCachedTerminalSurfaceIdsParams): string[] {
  if (maxCachedSurfaces <= 0) {
    return [];
  }

  const existingSessionIds = new Set(sessionIds);
  const nextCachedSessionIds = cachedSessionIds.filter(
    (terminalSessionId) =>
      existingSessionIds.has(terminalSessionId) &&
      terminalSessionId !== activeSessionId,
  );

  if (activeSessionId && existingSessionIds.has(activeSessionId)) {
    nextCachedSessionIds.push(activeSessionId);
  }

  return nextCachedSessionIds.slice(-maxCachedSurfaces);
}
