import type { TerminalInputMode, TerminalState } from "@runweave/shared";
import { fileToBase64, shellQuote } from "@runweave/common/terminal";
import { useCallback, useState, type RefObject } from "react";

import { recordSupportLog } from "../features/support-logs";
import { classifyApiFailure } from "../services/api-failure";
import {
  createTerminalSessionClipboardImage,
  interruptTerminalSession,
  sendTerminalInput,
} from "../services/terminal";
import { transcribeVoice } from "../services/voice";

interface UseAppTerminalActionsOptions {
  accessToken: string;
  apiBase: string;
  isDeviceOffline: boolean;
  onAuthExpired: () => void;
  refreshDeviceAfterFailure: () => void;
  terminalSessionId: string;
  terminalState: TerminalState;
  terminalStateRef: RefObject<TerminalState>;
}

interface UseAppTerminalActionsResult {
  handlePickImage: (file: File) => Promise<string>;
  handleSendCommand: (data: string) => Promise<void>;
  handleStop: () => void;
  handleTranscribeVoice: (
    payload: Parameters<typeof transcribeVoice>[2],
  ) => Promise<string>;
  imageError: string | null;
  isCommandActive: boolean;
  isPickingImage: boolean;
}

function resolveComposerInputMode(
  terminalState: TerminalState,
  data: string,
): TerminalInputMode {
  if (terminalState.agent === "codex" && data.trimStart().startsWith("/")) {
    return "codex_slash_command";
  }
  return "line";
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useAppTerminalActions({
  accessToken,
  apiBase,
  isDeviceOffline,
  onAuthExpired,
  refreshDeviceAfterFailure,
  terminalSessionId,
  terminalState,
  terminalStateRef,
}: UseAppTerminalActionsOptions): UseAppTerminalActionsResult {
  const [imageError, setImageError] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const isCommandActive = terminalState.state === "agent_running";

  const handleStop = useCallback(() => {
    setImageError(null);
    if (isDeviceOffline) {
      setImageError("本地电脑暂时不可用");
      return;
    }
    recordSupportLog("terminal.stop.clicked", {
      terminalSessionId,
      stateAtClick: terminalStateRef.current.state,
      agentAtClick: terminalStateRef.current.agent,
    });
    void interruptTerminalSession(apiBase, accessToken, terminalSessionId)
      .then(() => {
        recordSupportLog("terminal.stop.completed", {
          terminalSessionId,
          stateAfterSuccess: terminalStateRef.current.state,
          agentAfterSuccess: terminalStateRef.current.agent,
        });
      })
      .catch((nextError: unknown) => {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.stop.unauthorized",
            {
              terminalSessionId,
            },
            "warn",
          );
          onAuthExpired();
          return;
        }
        refreshDeviceAfterFailure();
        recordSupportLog(
          "terminal.stop.failed",
          {
            terminalSessionId,
            stateAfterFailure: terminalStateRef.current.state,
            error: getErrorMessage(nextError, String(nextError)),
          },
          "warn",
        );
        setImageError(getErrorMessage(nextError, "中断命令失败"));
      });
  }, [
    accessToken,
    apiBase,
    isDeviceOffline,
    onAuthExpired,
    refreshDeviceAfterFailure,
    terminalSessionId,
    terminalStateRef,
  ]);

  const handleSendCommand = useCallback(
    async (data: string): Promise<void> => {
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }
      const mode = resolveComposerInputMode(terminalStateRef.current, data);
      recordSupportLog("terminal.input.send.started", {
        terminalSessionId,
        hasNewline: data.includes("\n"),
        length: data.length,
        mode,
      });
      try {
        await sendTerminalInput(
          apiBase,
          accessToken,
          terminalSessionId,
          data,
          mode,
        );
        recordSupportLog("terminal.input.send.completed", {
          terminalSessionId,
          length: data.length,
          mode,
        });
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.input.send.unauthorized",
            {
              terminalSessionId,
              length: data.length,
              mode,
            },
            "warn",
          );
          onAuthExpired();
          return;
        }
        refreshDeviceAfterFailure();
        recordSupportLog(
          "terminal.input.send.failed",
          {
            terminalSessionId,
            error: getErrorMessage(nextError, String(nextError)),
            length: data.length,
            mode,
          },
          "warn",
        );
        setImageError(getErrorMessage(nextError, "命令发送失败"));
        throw nextError;
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
      terminalStateRef,
    ],
  );

  const handlePickImage = useCallback(
    async (file: File): Promise<string> => {
      setImageError(null);
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }

      setIsPickingImage(true);
      recordSupportLog("terminal.clipboard_image.upload.started", {
        terminalSessionId,
        mimeType: file.type,
        size: file.size,
      });
      try {
        const dataBase64 = await fileToBase64(file);
        const payload = await createTerminalSessionClipboardImage(
          apiBase,
          accessToken,
          terminalSessionId,
          {
            mimeType: file.type,
            dataBase64,
          },
        );
        recordSupportLog("terminal.clipboard_image.upload.completed", {
          terminalSessionId,
          filePathLength: payload.filePath.length,
        });
        return shellQuote(payload.filePath);
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.clipboard_image.upload.unauthorized",
            {
              terminalSessionId,
            },
            "warn",
          );
          onAuthExpired();
          throw nextError;
        }
        refreshDeviceAfterFailure();
        recordSupportLog(
          "terminal.clipboard_image.upload.failed",
          {
            terminalSessionId,
            error: getErrorMessage(nextError, String(nextError)),
          },
          "warn",
        );
        setImageError(getErrorMessage(nextError, "图片上传失败"));
        throw nextError;
      } finally {
        setIsPickingImage(false);
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
    ],
  );

  const handleTranscribeVoice = useCallback(
    async (payload: Parameters<typeof transcribeVoice>[2]): Promise<string> => {
      setImageError(null);
      if (isDeviceOffline) {
        setImageError("本地电脑暂时不可用");
        throw new Error("本地电脑暂时不可用");
      }
      recordSupportLog("terminal.voice.transcribe.started", {
        terminalSessionId,
        durationMs: payload.durationMs,
      });
      try {
        const response = await transcribeVoice(apiBase, accessToken, payload);
        recordSupportLog("terminal.voice.transcribe.completed", {
          terminalSessionId,
          textLength: response.text.length,
        });
        return response.text;
      } catch (nextError: unknown) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.voice.transcribe.unauthorized",
            {
              terminalSessionId,
            },
            "warn",
          );
          onAuthExpired();
          throw nextError;
        }
        refreshDeviceAfterFailure();
        recordSupportLog(
          "terminal.voice.transcribe.failed",
          {
            terminalSessionId,
            error: getErrorMessage(nextError, String(nextError)),
          },
          "warn",
        );
        setImageError(getErrorMessage(nextError, "语音转文字失败"));
        throw nextError;
      }
    },
    [
      accessToken,
      apiBase,
      isDeviceOffline,
      onAuthExpired,
      refreshDeviceAfterFailure,
      terminalSessionId,
    ],
  );

  return {
    handlePickImage,
    handleSendCommand,
    handleStop,
    handleTranscribeVoice,
    imageError,
    isCommandActive,
    isPickingImage,
  };
}
