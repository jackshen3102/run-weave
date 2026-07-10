import { useEffect } from "react";
import { HttpError } from "../../services/http";
import { getTerminalSession } from "../../services/terminal";

type MutableRef<T> = { current: T };

interface UseTerminalSnapshotRestoreArgs {
  active: boolean;
  apiBase: string;
  deferredSnapshotRef: MutableRef<string | null>;
  hasDeferredOutputRef: MutableRef<boolean>;
  hasRenderedSnapshotRef: MutableRef<boolean>;
  onAuthExpiredRef: MutableRef<(() => void) | undefined>;
  renderTerminalSnapshot: (data: string) => void;
  replayDeferredOutput: () => boolean;
  requiresSnapshotRestoreRef: MutableRef<boolean>;
  restoreSnapshotRequestRef: MutableRef<number>;
  terminalRef: MutableRef<unknown | null>;
  terminalSessionId: string;
  tokenRef: MutableRef<string>;
  websocketContentVersionRef: MutableRef<number>;
}

export function useTerminalSnapshotRestore({
  active,
  apiBase,
  deferredSnapshotRef,
  hasDeferredOutputRef,
  hasRenderedSnapshotRef,
  onAuthExpiredRef,
  renderTerminalSnapshot,
  replayDeferredOutput,
  requiresSnapshotRestoreRef,
  restoreSnapshotRequestRef,
  terminalRef,
  terminalSessionId,
  tokenRef,
  websocketContentVersionRef,
}: UseTerminalSnapshotRestoreArgs): void {
  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    let cancelled = false;
    const requestId = restoreSnapshotRequestRef.current + 1;
    restoreSnapshotRequestRef.current = requestId;

    const restoreSnapshot = async (attempt: number): Promise<void> => {
      const websocketContentVersionAtRequest =
        websocketContentVersionRef.current;
      try {
        const session = await getTerminalSession(
          apiBase,
          tokenRef.current,
          terminalSessionId,
        );
        if (cancelled || restoreSnapshotRequestRef.current !== requestId) {
          return;
        }

        if (
          websocketContentVersionRef.current !==
          websocketContentVersionAtRequest
        ) {
          if (requiresSnapshotRestoreRef.current && attempt < 2) {
            await restoreSnapshot(attempt + 1);
            return;
          }
          if (!requiresSnapshotRestoreRef.current) {
            return;
          }
        }

        renderTerminalSnapshot(session.scrollback);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        hasDeferredOutputRef.current = true;
        requiresSnapshotRestoreRef.current = true;
        if (error instanceof HttpError && error.status === 401) {
          onAuthExpiredRef.current?.();
        }
      }
    };

    if (
      hasRenderedSnapshotRef.current &&
      !hasDeferredOutputRef.current &&
      !requiresSnapshotRestoreRef.current
    ) {
      return () => {
        cancelled = true;
      };
    }

    if (
      !requiresSnapshotRestoreRef.current &&
      (hasRenderedSnapshotRef.current || deferredSnapshotRef.current !== null)
    ) {
      if (replayDeferredOutput()) {
        return () => {
          cancelled = true;
        };
      }
      hasDeferredOutputRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    void restoreSnapshot(0);

    return () => {
      cancelled = true;
    };
  }, [
    active,
    apiBase,
    deferredSnapshotRef,
    hasDeferredOutputRef,
    hasRenderedSnapshotRef,
    onAuthExpiredRef,
    renderTerminalSnapshot,
    replayDeferredOutput,
    requiresSnapshotRestoreRef,
    restoreSnapshotRequestRef,
    terminalRef,
    terminalSessionId,
    tokenRef,
    websocketContentVersionRef,
  ]);
}
