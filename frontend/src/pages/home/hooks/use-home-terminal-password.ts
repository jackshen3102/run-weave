import { useCallback, useState } from "react";
import type { TerminalSessionListItem } from "@browser-viewer/shared";
import { HttpError } from "../../../services/http";
import { changePassword as submitPasswordChange } from "../../../services/auth";
import {
  createTerminalSession,
  listTerminalSessions,
} from "../../../services/terminal";

interface UseHomeTerminalPasswordParams {
  apiBase: string;
  token: string;
  onAuthExpired: () => void;
  onOpenTerminalSession: (terminalSessionId: string) => void;
}

function resolveReusableTerminalSession(
  terminalSessions: TerminalSessionListItem[],
): TerminalSessionListItem | null {
  const runningSessions = terminalSessions
    .filter((session) => session.status === "running")
    .sort((left, right) => {
      return (
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );
    });

  return runningSessions[0] ?? null;
}

export function useHomeTerminalPassword({
  apiBase,
  token,
  onAuthExpired,
  onOpenTerminalSession,
}: UseHomeTerminalPasswordParams) {
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(
    null,
  );

  const createTerminal = useCallback(async (): Promise<void> => {
    if (terminalLoading) {
      return;
    }

    setTerminalLoading(true);
    setTerminalError(null);

    try {
      const existingTerminalSessions = await listTerminalSessions(apiBase, token);
      const reusableSession = resolveReusableTerminalSession(existingTerminalSessions);
      if (reusableSession) {
        onOpenTerminalSession(reusableSession.terminalSessionId);
        return;
      }

      const data = await createTerminalSession(apiBase, token, {});
      onOpenTerminalSession(data.terminalSessionId);
    } catch (createError) {
      if (createError instanceof HttpError && createError.status === 401) {
        onAuthExpired();
        return;
      }

      setTerminalError(String(createError));
    } finally {
      setTerminalLoading(false);
    }
  }, [apiBase, onAuthExpired, onOpenTerminalSession, terminalLoading, token]);

  const openPasswordDialog = useCallback((): void => {
    setPasswordChangeError(null);
    setPasswordDialogOpen(true);
  }, []);

  const closePasswordDialog = useCallback((): void => {
    if (passwordChangeLoading) {
      return;
    }

    setPasswordChangeError(null);
    setPasswordDialogOpen(false);
  }, [passwordChangeLoading]);

  const changePassword = useCallback(
    async (payload: { oldPassword: string; newPassword: string }): Promise<void> => {
      setPasswordChangeLoading(true);
      setPasswordChangeError(null);

      try {
        await submitPasswordChange(apiBase, token, payload);
        setPasswordDialogOpen(false);
        onAuthExpired();
      } catch (changeError) {
        if (changeError instanceof HttpError && changeError.status === 403) {
          setPasswordChangeError("Incorrect current password.");
          return;
        }
        if (changeError instanceof HttpError && changeError.status === 401) {
          onAuthExpired();
          return;
        }

        setPasswordChangeError(String(changeError));
      } finally {
        setPasswordChangeLoading(false);
      }
    },
    [apiBase, onAuthExpired, token],
  );

  return {
    terminalLoading,
    terminalError,
    createTerminal,
    passwordDialogOpen,
    passwordChangeLoading,
    passwordChangeError,
    openPasswordDialog,
    closePasswordDialog,
    changePassword,
  };
}
