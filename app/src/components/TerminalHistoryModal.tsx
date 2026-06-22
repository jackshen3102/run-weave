import { useMemoizedFn } from "ahooks";
import {
  countTerminalLines,
  normalizeTerminalHistoryOutput,
} from "@runweave/common/terminal";
import {
  TERMINAL_CLIENT_SCROLLBACK_LINES,
  type TerminalSessionHistoryResponse,
} from "@runweave/shared";
import {
  TerminalRenderer,
  type TerminalRendererExtensionContext,
  type TerminalRendererHandle,
} from "@runweave/terminal-renderer";
import { IonModal, IonSpinner } from "@ionic/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { recordSupportLog } from "../features/support-logs";
import { installTerminalTouchBehavior } from "../lib/app-terminal-touch-behavior";
import { classifyApiFailure } from "../services/api-failure";
import { getTerminalHistory } from "../services/terminal";

interface TerminalHistoryModalProps {
  accessToken: string;
  apiBase: string;
  isDeviceOffline: boolean;
  isOpen: boolean;
  terminalName?: string;
  terminalSessionId: string;
  onAuthExpired: () => void;
  onClose: () => void;
  onConnectionFailure: () => void;
}

const INTERACTIVE_SHELL_COMMANDS = new Set(["bash", "fish", "sh", "zsh"]);

function basename(value: string | undefined | null): string | null {
  const normalized = value?.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function formatHistoryTitle(
  history: TerminalSessionHistoryResponse | null,
): string {
  if (!history) {
    return "终端历史";
  }

  const baseLabel = history.alias?.trim() || basename(history.cwd) || "终端";
  const activeCommand = basename(history.activeCommand);
  if (!activeCommand || INTERACTIVE_SHELL_COMMANDS.has(activeCommand)) {
    return baseLabel;
  }
  return `${baseLabel}(${activeCommand})`;
}

function formatHistoryStatus(
  history: TerminalSessionHistoryResponse | null,
  terminalSessionId: string,
): string {
  if (!history) {
    return terminalSessionId;
  }

  const statusLabel =
    history.status === "exited"
      ? history.exitCode == null
        ? "已退出"
        : `已退出 (${history.exitCode})`
      : "运行中";
  return `${statusLabel}  ${history.cwd}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "加载终端历史失败";
}

export function TerminalHistoryModal({
  accessToken,
  apiBase,
  isDeviceOffline,
  isOpen,
  onAuthExpired,
  onClose,
  onConnectionFailure,
  terminalName,
  terminalSessionId,
}: TerminalHistoryModalProps) {
  const rendererRef = useRef<TerminalRendererHandle | null>(null);
  const [history, setHistory] =
    useState<TerminalSessionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const output = history?.scrollback ?? "";
  const normalizedOutput = useMemo(
    () => normalizeTerminalHistoryOutput(output),
    [output],
  );
  const scrollbackLines = useMemo(
    () =>
      Math.max(
        TERMINAL_CLIENT_SCROLLBACK_LINES,
        countTerminalLines(output) + 16,
      ),
    [output],
  );
  const renderedTitle = terminalName ?? formatHistoryTitle(history);
  const renderedStatus = formatHistoryStatus(history, terminalSessionId);

  const renderOutput = useMemoizedFn(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    renderer.resetAndWrite(normalizedOutput);
    renderer.refresh();
  });

  const handleTerminalReady = useMemoizedFn(
    (context: TerminalRendererExtensionContext) => {
      const disposable = installTerminalTouchBehavior(context, {
        allowMouseDragScroll: true,
      });
      renderOutput();
      return disposable;
    },
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    renderOutput();
  }, [isOpen, normalizedOutput, renderOutput]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    setHistory(null);
    setRequestError(null);

    if (isDeviceOffline) {
      setLoading(false);
      setRequestError("本地电脑暂时不可用");
      return;
    }

    setLoading(true);
    recordSupportLog("terminal.history.load.started", {
      terminalSessionId,
    });

    void getTerminalHistory(apiBase, accessToken, terminalSessionId)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setHistory(payload);
        recordSupportLog("terminal.history.load.completed", {
          terminalSessionId,
          scrollbackLength: payload.scrollback.length,
        });
      })
      .catch((nextError: unknown) => {
        if (cancelled) {
          return;
        }
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          recordSupportLog(
            "terminal.history.load.unauthorized",
            {
              terminalSessionId,
            },
            "warn",
          );
          onAuthExpired();
          return;
        }
        if (
          failure.kind === "network-unreachable" ||
          failure.kind === "timeout"
        ) {
          onConnectionFailure();
        }
        setRequestError(errorMessage(nextError));
        recordSupportLog(
          "terminal.history.load.failed",
          {
            terminalSessionId,
            error: errorMessage(nextError),
          },
          "warn",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    accessToken,
    apiBase,
    isDeviceOffline,
    isOpen,
    onAuthExpired,
    onConnectionFailure,
    terminalSessionId,
  ]);

  return (
    <IonModal
      className="terminal-history-modal"
      isOpen={isOpen}
      onDidDismiss={onClose}
    >
      <section aria-label="终端历史" className="terminal-history-panel">
        <header className="terminal-history-panel__header">
          <div className="terminal-history-panel__title">
            <h2>{renderedTitle}</h2>
            <p>{renderedStatus}</p>
          </div>
          <button
            aria-label="关闭终端历史"
            className="terminal-history-panel__close"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </header>
        {requestError ? (
          <p className="terminal-history-panel__message is-error">
            {requestError}
          </p>
        ) : null}
        {loading ? (
          <p className="terminal-history-panel__message">
            <IonSpinner name="crescent" />
            加载中...
          </p>
        ) : null}
        <div className="terminal-history-panel__body">
          <TerminalRenderer
            active={isOpen}
            className="terminal-history-panel__renderer"
            focusOnInteraction={false}
            fontSize={12}
            onTerminalReady={handleTerminalReady}
            readOnly
            ref={rendererRef}
            renderer="dom"
            scrollbackLines={scrollbackLines}
          />
        </div>
      </section>
    </IonModal>
  );
}
