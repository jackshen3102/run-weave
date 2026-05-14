import { useEffect } from "react";
import { HttpError } from "../../services/http";
import { getTerminalSession } from "../../services/terminal";

type MutableRef<T> = { current: T };

interface UseTerminalSnapshotRestoreArgs {
  active: boolean;
  apiBase: string;
  hasDeferredOutputRef: MutableRef<boolean>;
  hasRenderedSnapshotRef: MutableRef<boolean>;
  onAuthExpiredRef: MutableRef<(() => void) | undefined>;
  onMetadataRef: MutableRef<
    | ((metadata: { cwd: string; activeCommand: string | null }) => void)
    | undefined
  >;
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
  hasDeferredOutputRef,
  hasRenderedSnapshotRef,
  onAuthExpiredRef,
  onMetadataRef,
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

    if (
      hasRenderedSnapshotRef.current &&
      !hasDeferredOutputRef.current &&
      !requiresSnapshotRestoreRef.current
    ) {
      return () => {
        cancelled = true;
      };
    }

    if (hasRenderedSnapshotRef.current && !requiresSnapshotRestoreRef.current) {
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

        onMetadataRef.current?.({
          cwd: session.cwd,
          activeCommand: session.activeCommand,
        });
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

    void restoreSnapshot(0);

    return () => {
      cancelled = true;
    };
  }, [
    active,
    apiBase,
    hasDeferredOutputRef,
    hasRenderedSnapshotRef,
    onAuthExpiredRef,
    onMetadataRef,
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
